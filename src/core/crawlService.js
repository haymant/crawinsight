const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { BasicCrawler } = require('crawlee');
const { sql } = require('drizzle-orm');
const { getPlugin } = require('../plugins');
const { DepthController } = require('../services/depthController');
const { HybridFetchRouter } = require('../services/hybridFetchRouter');
const { analyzeArticle, buildArticleContextSnippets } = require('../services/analysisService');
const { RawContentStore } = require('../storage/rawContentStore');
const { isGoogleNewsArticleUrl, resolveGoogleNewsPublisherUrl } = require('../utils/googleNewsResolver');
const { validateArticleContent } = require('../utils/validateArticleContent');

function normalizeComparableUrl(candidate) {
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    parsed.hash = '';

    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }

    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return null;
  }
}

class CrawlService {
  constructor({ sourceConfigService, articleRepository, sentimentService, jobService, rawContentStore, queueService, depthController, hybridFetchRouter }) {
    this.sourceConfigService = sourceConfigService;
    this.articleRepository = articleRepository;
    this.sentimentService = sentimentService;
    this.jobService = jobService;
    this.rawContentStore = rawContentStore;
    this.queueService = queueService;
    this.depthController = depthController || new DepthController();
    this.hybridFetchRouter = hybridFetchRouter || new HybridFetchRouter();
  }

  async resolveRawContentStore(source) {
    if (!source?.storeDir) {
      return this.rawContentStore;
    }

    // If a storage record exists, prefer it; otherwise, treat storeDir as a relative
    // subfolder under the existing raw content path.
    const rootBase = this.rawContentStore?.basePath || process.cwd();
    const ensureRawDir = (base) => {
      if (!base) return base;
      const normalized = String(base);
      const last = path.basename(normalized).toLowerCase();
      if (last === 'raw') return normalized;
      return path.join(normalized, 'raw');
    };

    try {
      const { db } = require('../db');
      if (db && typeof db.execute === 'function') {
        const result = await db.execute(sql`SELECT * FROM storages WHERE storage_id = ${source.storeDir}`);
        const storage = (result?.rows || [])[0];
        if (storage && storage.type === 'filesystem') {
          const config = storage.config || {};
          const base = String(config.base_path || config.path || config.basePath || '').trim();
          const rawBase = ensureRawDir(base || rootBase);
          return new RawContentStore(path.join(rawBase, source.storeDir));
        }
      }
    } catch (e) {
      console.error('failed to resolve raw content store for storeDir', source.storeDir, e);
    }

    const rawBase = ensureRawDir(rootBase);
    return new RawContentStore(path.join(rawBase, source.storeDir));
  }

  async runSource(sourceName, options = {}) {
    if (!sourceName) {
      throw new Error('Source name required');
    }
    console.log(`runSource called with '${sourceName}'`);
    const source = await this.sourceConfigService.getSource(sourceName);
    if (!source) {
      throw new Error(`Unknown source: ${sourceName}`);
    }
    if (source.disabled) {
      throw new Error(`Source is disabled: ${sourceName}`);
    }

    console.log(`creating job for source ${sourceName}`);
    const job = await this.jobService.createJob('scrape', { source: sourceName });

    if (this.queueService?.isEnabled() && !options.forceInline) {
      const queueId = await this.queueService.publishScrapeJob({ jobId: job.id, source: sourceName });
      console.log(`enqueued job ${job.id} on pg-boss, queueId=${queueId}`);
      await this.jobService.updateJob(job.id, {
        status: 'queued',
        queueId: queueId || null,
      });
      return { jobId: job.id, queueId: queueId || null, status: 'queued' };
    }

    return this.processJob(job.id, sourceName, source, {
      queueId: null,
      forceInline: options.forceInline || false,
      maxCrawlDepth: Number.isInteger(options.maxCrawlDepth) ? options.maxCrawlDepth : undefined,
    });
  }

  async processQueuedJob(job) {
    const sourceName = job?.data?.source;
    const jobId = job?.data?.jobId;
    if (!sourceName || !jobId) {
      return;
    }

    const source = await this.sourceConfigService.getSource(sourceName);
    if (!source) {
      await this.jobService.updateJob(jobId, { status: 'failed', error: `Unknown source: ${sourceName}` });
      return;
    }
    if (source.disabled) {
      await this.jobService.updateJob(jobId, { status: 'failed', error: `Source is disabled: ${sourceName}` });
      return;
    }

    await this.processJob(jobId, sourceName, source, { queueId: job.id || null, forceInline: false });
  }

  async processJob(jobId, sourceName, source, options = {}) {
    console.log(`processing job ${jobId} for source ${sourceName}`);
    if (source.storeDir) {
      console.log(`source has custom storeDir=${source.storeDir}`);
    }
    await this.jobService.updateJob(jobId, {
      status: 'running',
      queueId: options.queueId || null,
      startedAt: new Date().toISOString(),
    });

    try {
      const rawContentStore = await this.resolveRawContentStore(source);
      const result = await this.executeSource(sourceName, source, { rawContentStore, maxCrawlDepth: options.maxCrawlDepth });
      if (this.sentimentService && result.articleIds?.length) {
        result.analysis = await this.sentimentService.requestAnalysis({
          source: sourceName,
          articleIds: result.articleIds,
          parentJobId: jobId,
          forceInline: options.forceInline ?? !this.queueService?.isEnabled(),
        });
      }
      const status = result.failedRequestCount > 0 ? 'completed_with_errors' : 'completed';
      console.log(`job ${jobId} finished: fetched=${result.fetchedCount} stored=${result.storedCount} failures=${result.failedRequestCount}`);
      await this.jobService.updateJob(jobId, {
        status,
        result,
        finishedAt: new Date().toISOString(),
      });
      return { jobId, queueId: options.queueId || null, status, ...result };
    } catch (error) {
      console.error(`job ${jobId} failed:`, error.message);
      await this.jobService.updateJob(jobId, {
        status: 'failed',
        error: error.message,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async checkSourceSession(sourceName) {
    const source = await this.sourceConfigService.getSource(sourceName);
    if (!source) {
      throw new Error(`Unknown source: ${sourceName}`);
    }

    const plugin = getPlugin(source.type);
    const requests = plugin.expandRequests(source);
    const firstRequest = requests?.[0];
    if (!firstRequest) {
      throw new Error('No requests configured for source');
    }

    const headers = {};
    if (source.headers?.userAgent) {
      headers['user-agent'] = source.headers.userAgent;
    }

    const sessionState = source.sessionState || source.options?.sessionState;
    const hasBrowserLinkedFetcher = typeof plugin.fetchLinkedArticleWithBrowser === 'function';

    try {
      let responseBody;
      let fetchMode = 'http';

      // Fetch the feed (or landing URL) first so we can locate a linked article to test.
      const axiosResp = await axios.get(firstRequest.url, { headers, timeout: 15000 });
      responseBody = axiosResp.data;

      const parsedItems = typeof plugin.parse === 'function' ? await plugin.parse({ body: responseBody }) : [];
      const firstItemLink = Array.isArray(parsedItems) && parsedItems[0]?.link;

      if (hasBrowserLinkedFetcher && firstItemLink) {
        const response = await plugin.fetchLinkedArticleWithBrowser(firstItemLink, headers, sessionState);
        const ok = Boolean(response?.body && (typeof response.body !== 'string' || response.body.length > 0));
        return { ok, fetchMode: 'browser', url: firstItemLink };
      }

      const ok = Boolean(responseBody && (typeof responseBody !== 'string' || responseBody.length > 0));
      return { ok, fetchMode, url: firstRequest.url };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  async executeSource(sourceName, source, options = {}) {
    const plugin = getPlugin(source.type);
    const requests = plugin.expandRequests(source);
    const runId = `${sourceName}:${Date.now()}`;
    const analyzedArticles = [];
    const failedRequests = [];
    let successfulRequests = 0;
    const crawlService = this;
    const rawContentStore = options.rawContentStore || this.rawContentStore;

    const maxCrawlDepth = Math.max(
      1,
      Number.isInteger(options.maxCrawlDepth)
        ? options.maxCrawlDepth
        : source.options?.maxCrawlDepth || 1
    );

    const sessionState = source.sessionState || source.options?.sessionState;
    const useBrowser = (source.options?.browser || source.options?.useSession) && typeof plugin.fetchWithBrowser === 'function';
    const crawler = new BasicCrawler({
      maxConcurrency: source.concurrency || 2,
      async requestHandler({ request }) {
        const headers = {};
        if (source.headers?.userAgent) {
          headers['user-agent'] = source.headers.userAgent;
        }

        let body;
        let contentType;
        if (useBrowser) {
          body = await plugin.fetchWithBrowser(request.url, headers, sessionState);
          successfulRequests += 1;
        } else {
          const response = await axios.get(request.url, { headers, timeout: 15000 });
          successfulRequests += 1;
          body = response.data;
          contentType = response.headers['content-type'];
        }

        const rawContentPath = rawContentStore
          ? await rawContentStore.write({
              sourceName,
              url: request.url,
              body,
              contentType,
              capturedAt: new Date().toISOString(),
            })
          : null;
        const parsed = await plugin.parse({ body, metadata: request.userData?.metadata || {} });
        const limit = source.options?.maxItemsPerFeed || parsed.length;

        for (const item of parsed.slice(0, limit)) {
          const analyzed = analyzeArticle(item, { sourceName, filters: source.filters });
          if (analyzed.isRelevant) {
            analyzed.id = CrawlService.createArticleId(analyzed.link || analyzed.title || request.url);
            analyzed.fullContentPath = rawContentPath;
            analyzed.linkedArticleIds = Array.isArray(analyzed.linkedArticleIds) ? analyzed.linkedArticleIds : [];
            analyzed.crawlDepth = 1;
            analyzed.ingestedAt = new Date().toISOString();
            analyzed.metadata = CrawlService.mergeMetadata(analyzed.metadata, {
              fullArticlePath: rawContentPath,
              contextSnippets: buildArticleContextSnippets(analyzed),
              maxCrawlDepth,
            });
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

    console.log(`executeSource result for ${sourceName}: ${successfulRequests} success, ${failedRequests.length} failures`);

    // Follow linked article URLs up to maxCrawlDepth (default 1).
    const depth2 = {
      attempted: 0,
      followed: 0,
      succeeded: 0,
      skippedByGate: 0,
    };
    if (maxCrawlDepth > 1 && rawContentStore) {
      const processedIds = new Set(analyzedArticles.map((a) => a.id));
      const additionalArticles = [];
      const hasBrowserFetcher = typeof plugin.fetchLinkedArticleWithBrowser === 'function';
      const browserMode = source.options?.linkedArticleBrowserFallback;
      const useBrowserFirst = hasBrowserFetcher && browserMode === 'always';
      const useBrowserFallback = hasBrowserFetcher && browserMode !== false;
      const pluginBrowserFetcher = hasBrowserFetcher
        ? async (url, headers) => plugin.fetchLinkedArticleWithBrowser(url, headers, sessionState)
        : null;

      for (const article of [...analyzedArticles]) {
        depth2.attempted += 1;
        const gate = this.depthController.evaluate({ article, source, maxCrawlDepth });
        if (!gate.allowed) {
          article.metadata = CrawlService.mergeMetadata(article.metadata, {
            depth2FetchedAt: new Date().toISOString(),
            depth2Success: false,
            depth2Reason: gate.reason,
            depth2KeywordsMatched: gate.keywordsMatched || [],
          });
          if (gate.reason === 'keyword-miss') {
            depth2.skippedByGate += 1;
          }
          continue;
        }

        depth2.followed += 1;
        let fetchResult = { article: null, reason: 'fetch-failed' };

        if (useBrowserFirst && pluginBrowserFetcher) {
          fetchResult = await this._fetchLinkedArticle({
            parentArticle: article,
            sourceName,
            source,
            rawContentStore,
            maxDepth: maxCrawlDepth,
            processedIds,
            browserFetcher: pluginBrowserFetcher,
          });
        } else {
          fetchResult = await this._fetchLinkedArticle({
            parentArticle: article,
            sourceName,
            source,
            rawContentStore,
            maxDepth: maxCrawlDepth,
            processedIds,
            fallbackFetcher: useBrowserFallback ? pluginBrowserFetcher : null,
          });
        }

        const child = fetchResult.article;

        article.metadata = CrawlService.mergeMetadata(article.metadata, {
          depth2FetchedAt: new Date().toISOString(),
          depth2Success: Boolean(child),
          depth2Reason: fetchResult.reason || (child ? 'fetched' : 'fetch-failed'),
          depth2KeywordsMatched: gate.keywordsMatched || [],
          depth2ValidationExcerpt: fetchResult.validation?.excerpt,
          depth2ValidationReason: fetchResult.validation?.reason,
          depth2ResolvedLink: fetchResult.resolvedUrl,
        });
        if (child) {
          depth2.succeeded += 1;
          additionalArticles.push(child);
        }
      }

      if (additionalArticles.length > 0) {
        analyzedArticles.push(...additionalArticles);
      }
    }

    // Articles must always land in the primary repository so downstream
    // sentiment analysis can read them back. A filesystem storeDir is treated
    // as an optional mirror destination, not the source of truth.
    let mirrorRepo = null;
    if (source.storeDir && typeof source.storeDir === 'string') {
      try {
        const { db } = require('../db');
        let storage = null;
        try {
          const result = await db.execute(sql`SELECT * FROM storages WHERE storage_id = ${source.storeDir}`);
          const storageRows = result.rows || [];
          storage = storageRows[0];
        } catch (e) {
          console.error('storage lookup failed', e);
        }
        if (storage && storage.type === 'filesystem') {
          const config = storage.config || {};
          const base = String(config.base_path || config.path || config.basePath || '').trim();
          if (base) {
            const { ArticleRepository } = require('../storage/articleRepository');
            const path = require('path');
            const dest = path.join(base, source.storeDir, 'articles.json');
            mirrorRepo = new ArticleRepository(dest);
          }
        }
      } catch (e) {
        console.error('failed to resolve storage for storeDir', source.storeDir, e);
      }
    }
    const stored = await this.articleRepository.insertMany(analyzedArticles);
    if (mirrorRepo) {
      await mirrorRepo.insertMany(analyzedArticles);
    }

    return {
      source: sourceName,
      fetchedCount: analyzedArticles.length,
      storedCount: stored.length,
      articleIds: stored.map((article) => article.id),
      successfulRequestCount: successfulRequests,
      failedRequestCount: failedRequests.length,
      failures: failedRequests,
      maxCrawlDepth,
      depth2,
    };
  }

  async _fetchLinkedArticle({ parentArticle, sourceName, source, rawContentStore, maxDepth, processedIds, fallbackFetcher, browserFetcher }) {
    if (!parentArticle?.link) return { article: null, reason: 'no-link' };
    const nextDepth = (parentArticle.crawlDepth || 1) + 1;
    if (nextDepth > maxDepth) return { article: null, reason: 'max-depth' };

    const initialUrl = parentArticle.link;
    const headers = {};
    if (source?.headers?.userAgent) {
      headers['user-agent'] = source.headers.userAgent;
    }

    let url = initialUrl;
    let id = CrawlService.createArticleId(`${url}|depth=${nextDepth}`);
    if (processedIds.has(id)) return { article: null, reason: 'duplicate' };
    processedIds.add(id);

    let body;
    let contentType;
    let fetchMode = 'http';
    let validation = null;

    const fetchLinkedContent = async (targetUrl) => {
      if (browserFetcher) {
        const response = await browserFetcher(targetUrl, headers);
        return {
          body: response.body,
          contentType: response.contentType,
          fetchMode: 'browser',
          resolvedUrl: response.resolvedUrl || targetUrl,
        };
      }

      return this.hybridFetchRouter.fetch({
        url: targetUrl,
        headers,
        timeout: 15000,
        fallbackFetcher,
      });
    };

    try {
      let response = await fetchLinkedContent(url);
      body = response.body;
      contentType = response.contentType;
      fetchMode = response.fetchMode || 'http';

      if (isGoogleNewsArticleUrl(url)) {
        let resolvedPublisherUrl = resolveGoogleNewsPublisherUrl({
          sourceUrl: url,
          resolvedUrl: response.resolvedUrl,
          body,
        });

        if (!resolvedPublisherUrl && fallbackFetcher && !browserFetcher) {
          const browserResponse = await fallbackFetcher(url, headers);
          resolvedPublisherUrl = resolveGoogleNewsPublisherUrl({
            sourceUrl: url,
            resolvedUrl: browserResponse?.resolvedUrl,
            body: browserResponse?.body,
          });

          if (resolvedPublisherUrl) {
            response = {
              body: browserResponse.body,
              contentType: browserResponse.contentType,
              fetchMode: 'fallback',
              resolvedUrl: browserResponse.resolvedUrl,
            };
            body = response.body;
            contentType = response.contentType;
            fetchMode = response.fetchMode || fetchMode;
          }
        }

        if (resolvedPublisherUrl) {
          const resolvedId = CrawlService.createArticleId(`${resolvedPublisherUrl}|depth=${nextDepth}`);
          if (processedIds.has(resolvedId)) {
            return { article: null, reason: 'duplicate', resolvedUrl: resolvedPublisherUrl };
          }

          processedIds.delete(id);
          processedIds.add(resolvedId);
          url = resolvedPublisherUrl;
          id = resolvedId;

          const normalizedResolvedPublisherUrl = normalizeComparableUrl(resolvedPublisherUrl);
          const normalizedResponseUrl = normalizeComparableUrl(response.resolvedUrl);
          const alreadyLoadedResolvedPublisher = Boolean(body)
            && normalizedResolvedPublisherUrl
            && normalizedResponseUrl
            && normalizedResolvedPublisherUrl === normalizedResponseUrl;

          if (!alreadyLoadedResolvedPublisher) {
            response = await fetchLinkedContent(resolvedPublisherUrl);
            body = response.body;
            contentType = response.contentType;
            fetchMode = response.fetchMode || fetchMode;
          }
        }
      }

      const shouldValidateDepth2 = source?.options?.validateDepth2Content === true || isGoogleNewsArticleUrl(initialUrl);
      if (shouldValidateDepth2) {
        validation = validateArticleContent({
          body,
          contentType,
          parentTitle: parentArticle.title,
          parentSummary: parentArticle.summary,
        });

        if (!validation.isValid) {
          return {
            article: null,
            reason: validation.reason,
            validation,
            resolvedUrl: url,
          };
        }
      }
    } catch (e) {
      // If we can't fetch the linked content, silently skip it.
      return { article: null, reason: 'fetch-failed', resolvedUrl: url };
    }

    const fetchedAt = new Date().toISOString();
    const rawContentPath = rawContentStore
      ? await rawContentStore.write({
          sourceName,
          url,
          body,
          contentType,
          capturedAt: fetchedAt,
        })
      : null;

    const child = {
      id,
      source: sourceName,
      title: parentArticle.title || url,
      link: url,
      publishedAt: parentArticle.publishedAt || null,
      fullContentPath: rawContentPath,
      summary: '',
      content: validation?.cleanedContent || (typeof body === 'string' ? body : JSON.stringify(body)),
      rawAssets: parentArticle.rawAssets || [],
      linkedArticleIds: [],
      crawlDepth: nextDepth,
      ingestedAt: fetchedAt,
      isRelevant: true,
      metadata: CrawlService.mergeMetadata(parentArticle.metadata, {
        parentArticleId: parentArticle.id,
        parentArticleLink: parentArticle.link,
        resolvedArticleLink: url !== initialUrl ? url : undefined,
        depth2FetchedAt: fetchedAt,
        depth2Success: true,
        fetchMode,
        contentType: contentType || null,
        fullArticlePath: rawContentPath,
        depth2ValidationReason: validation?.reason,
        depth2ValidationExcerpt: validation?.excerpt,
        depth2TitleSimilarity: validation?.titleSimilarity,
        depth2KeywordMatches: validation?.keywordMatches,
      }),
    };
    child.metadata = CrawlService.mergeMetadata(child.metadata, {
      contextSnippets: buildArticleContextSnippets(child),
    });

    parentArticle.linkedArticleIds = Array.isArray(parentArticle.linkedArticleIds)
      ? parentArticle.linkedArticleIds
      : [];
    parentArticle.linkedArticleIds.push(id);

    return {
      article: child,
      reason: 'fetched',
      validation,
      resolvedUrl: url,
    };
  }

  static createArticleId(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
  }

  static mergeMetadata(base, patch) {
    const normalizedBase = base && typeof base === 'object' ? base : {};
    const normalizedPatch = patch && typeof patch === 'object' ? patch : {};
    const merged = { ...normalizedBase, ...normalizedPatch };
    return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
  }
}

module.exports = { CrawlService };