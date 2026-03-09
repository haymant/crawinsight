const axios = require('axios');
const { BasicCrawler } = require('crawlee');
const { getPlugin } = require('../plugins');
const { analyzeArticle } = require('../services/analysisService');

class CrawlService {
  constructor({ sourceConfigService, articleRepository, jobService }) {
    this.sourceConfigService = sourceConfigService;
    this.articleRepository = articleRepository;
    this.jobService = jobService;
  }

  async runSource(sourceName) {
    const source = this.sourceConfigService.getSource(sourceName);
    if (!source) {
      throw new Error(`Unknown source: ${sourceName}`);
    }

    const job = this.jobService.createJob('scrape', { source: sourceName });
    this.jobService.updateJob(job.id, { status: 'running' });

    try {
      const result = await this.executeSource(sourceName, source);
      const status = result.failedRequestCount > 0 ? 'completed_with_errors' : 'completed';
      this.jobService.updateJob(job.id, { status, result });
      return { jobId: job.id, status, ...result };
    } catch (error) {
      this.jobService.updateJob(job.id, { status: 'failed', error: error.message });
      throw error;
    }
  }

  async executeSource(sourceName, source) {
    const plugin = getPlugin(source.type);
    const requests = plugin.expandRequests(source);
    const runId = `${sourceName}:${Date.now()}`;
    const analyzedArticles = [];
    const failedRequests = [];
    let successfulRequests = 0;

    const crawler = new BasicCrawler({
      maxConcurrency: source.concurrency || 2,
      async requestHandler({ request }) {
        const headers = {};
        if (source.headers?.userAgent) {
          headers['user-agent'] = source.headers.userAgent;
        }

        const response = await axios.get(request.url, { headers, timeout: 15000 });
        successfulRequests += 1;
        const parsed = await plugin.parse({ body: response.data, metadata: request.userData?.metadata || {} });
        const limit = source.options?.maxItemsPerFeed || parsed.length;

        for (const item of parsed.slice(0, limit)) {
          const analyzed = analyzeArticle(item, { sourceName, filters: source.filters });
          if (analyzed.isRelevant) {
            analyzedArticles.push(analyzed);
          }
        }
      },
      async failedRequestHandler({ request }) {
        failedRequests.push({
          url: request.url,
          errors: request.errorMessages || [],
        });
      },
    });

    await crawler.run(requests.map((request, index) => ({
      url: request.url,
      uniqueKey: `${runId}:${index}:${request.url}`,
      userData: { metadata: request.metadata },
    })));

    if (successfulRequests === 0 && failedRequests.length > 0) {
      const error = new Error(`All requests failed for source: ${sourceName}`);
      error.details = failedRequests;
      throw error;
    }

    const stored = this.articleRepository.insertMany(analyzedArticles);

    return {
      source: sourceName,
      fetchedCount: analyzedArticles.length,
      storedCount: stored.length,
      successfulRequestCount: successfulRequests,
      failedRequestCount: failedRequests.length,
      failures: failedRequests,
    };
  }
}

module.exports = { CrawlService };