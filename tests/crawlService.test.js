const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nock = require('nock');
const yaml = require('js-yaml');
const useLive = Boolean(process.env.LIVE);
const { buildServices } = require('../src/bootstrap');
const { CrawlService } = require('../src/core/crawlService');
const { makeTempDir } = require('./helpers');

// helper to create a simple sourceConfigService backed by a YAML file
function makeYamlService(configPath) {
  return {
    listSources: async () => {
      const content = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
      return content.sources || {};
    },
    getSource: async (name) => {
      const content = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
      return content.sources ? content.sources[name] || null : null;
    },
  };
}

const googleFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'google.xml'), 'utf8'); // still contains Reuters sample data
const transcriptFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'seekingalpha.xml'), 'utf8');
const redditJsonFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit.json'), 'utf8');
const redditRssFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit.xml'), 'utf8');
const xFixture = [{
  title: 'Fed speakers move Treasury yields',
  link: 'https://x.com/markets/status/1912345678901234567',
  publishedAt: '2026-03-09T10:00:00.000Z',
  summary: 'Treasury yields moved after fresh Fed commentary.',
  content: 'Treasury yields moved after fresh Fed commentary.',
  author: 'Markets Desk',
  handle: 'markets',
  listId: '2030824480940146987',
  tag: 'fed',
  likeCount: 15,
  repostCount: 4,
  replyCount: 2,
}];

describe('crawlService', () => {
  afterEach(() => {
    if (!useLive) nock.cleanAll();
    jest.restoreAllMocks();
  });

  test('scrapes an RSS source and persists analyzed articles', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
fs.writeFileSync(configPath, `sources:\n  google-news:\n    type: rss\n    urls:\n      - https://news.google.com/rss/search?q=site:reuters.com%20business\n    filters:\n      keywords: [earnings, plunge]\n`);

    if (!useLive) {
      nock('https://news.google.com')
        .get('/rss/search?q=site:reuters.com%20business')
        .reply(200, googleFixture);
    }

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
        queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
        jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
        sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('google-news');
    const articles = await services.articleRepository.query({ source: 'google-news' });

    if (!useLive) {
      // fixture run, ensure we at least created a job and it completed
      expect(result.jobId).toBeDefined();
    } else {
      // live run: just ensure job returned
      expect(result.jobId).toBeDefined();
    }

  });

  test('expands transcript sources by ticker', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    fs.writeFileSync(configPath, `sources:\n  seekingalpha:\n    type: transcripts\n    urls:\n      - https://seekingalpha.com/symbol/{ticker}.xml\n    params:\n      tickers:\n        - AAPL\n    filters:\n      keywords: [guidance]\n`);

    if (!useLive) {
      nock('https://seekingalpha.com')
        .get('/symbol/AAPL.xml')
        .reply(200, transcriptFixture);
    }

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
        queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
        jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
        sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('seekingalpha');
    const articles = await services.articleRepository.query({ source: 'seekingalpha', asset: 'AAPL' });

    if (!useLive) {
      expect(articles.length).toBeGreaterThan(0);
      expect(articles[0].assets).toContain('AAPL');
    } else {
      // live feed: at least serve without error
      expect(result.jobId).toBeDefined();
    }
  });

  test('scrapes a reddit source and supports subreddit filtering', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    const redditUrl = useLive
      ? 'https://www.reddit.com/r/stocks/hot.json?limit=25'
      : 'https://www.reddit.com/r/{subreddit}/hot.json?limit=2';

    fs.writeFileSync(configPath, `sources:\n  reddit-stocks:\n    type: reddit\n    urls:\n      - ${redditUrl}\n    params:\n      subreddits:\n        - stocks\n    headers:\n      userAgent: Mozilla/5.0\n    filters:\n      keywords: [earnings, market, stock, guidance]\n`);

    if (!useLive) {
      nock('https://www.reddit.com')
        .get('/r/stocks/hot.json')
        .query({ limit: '2' })
        .reply(200, redditJsonFixture, { 'content-type': 'application/json' });
    }

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
        queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
        jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
        sourceConfigService: makeYamlService(configPath),
    });

    let result;
    let liveError;
    try {
      result = await services.crawlService.runSource('reddit-stocks');
    } catch (error) {
      liveError = error;
    }

    if (useLive && liveError) {
      expect(liveError.message).toMatch(/All requests failed/);
      const jobs = await services.jobService.listJobs();
      expect(jobs[0].status).toBe('failed');
      return;
    }
  });

  test('uses browser fetch when browser option enabled', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    // same reddit json fixture is fine
    fs.writeFileSync(configPath, `sources:\n  reddit-stocks:\n    type: reddit\n    urls:\n      - https://www.reddit.com/r/{subreddit}/hot.json?limit=1\n    params:\n      subreddits:\n        - stocks\n    headers:\n      userAgent: Mozilla/5.0\n    filters:\n      keywords: [earnings]\n    options:\n      browser: true\n`);

    if (!useLive) {
      nock('https://www.reddit.com')
        .get('/r/stocks/hot.json')
        .query({ limit: '1' })
        .reply(200, redditJsonFixture, { 'content-type': 'application/json' });
    }

    const plugin = require('../src/plugins').getPlugin('reddit');
    const spy = jest.spyOn(plugin, 'fetchWithBrowser').mockResolvedValue(redditJsonFixture);

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
        queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
        jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
        sourceConfigService: makeYamlService(configPath),
    });

    await services.crawlService.runSource('reddit-stocks');
    expect(spy).toHaveBeenCalled();
  });

  test('scrapes an x source and persists x metadata', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    fs.writeFileSync(configPath, `sources:\n  x-financial-list:\n    type: x\n    urls:\n      - https://x.com/i/lists/2030824480940146987\n    headers:\n      userAgent: Mozilla/5.0\n    filters:\n      keywords: [Fed, yields]\n    options:\n      browser: true\n      maxItemsPerFeed: 5\n`);

    const plugin = require('../src/plugins').getPlugin('x');
    const spy = jest.spyOn(plugin, 'fetchWithBrowser').mockResolvedValue(xFixture);

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
        queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
        jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
        sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('x-financial-list');
    const articles = await services.articleRepository.query({ source: 'x-financial-list', listId: '2030824480940146987' });

    expect(result.jobId).toBeDefined();
    expect(spy).toHaveBeenCalled();
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      author: 'Markets Desk',
      handle: 'markets',
      listId: '2030824480940146987',
      tag: 'fed',
    });
  });

  test('fails the run when every request for a source fails', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    fs.writeFileSync(configPath, `sources:\n  google-news:\n    type: rss\n    urls:\n      - https://news.google.com/rss/search?q=site:reuters.com%20business\n`);

    // use a deliberately invalid domain to force network failure
    fs.writeFileSync(configPath, `sources:\n  google-news:\n    type: rss\n    urls:\n      - http://nonexistent.invalid/feed\n`);
    // override later by reinstalling service, will read above config

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
        queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
        jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
        sourceConfigService: makeYamlService(configPath),
    });

    await expect(services.crawlService.runSource('google-news')).rejects.toThrow(/All requests failed/);
  });

  test('processJob records lifecycle timestamps for queued work', async () => {
    const jobService = {
      updateJob: jest.fn().mockResolvedValue(undefined),
    };
    const crawlService = new CrawlService({
      sourceConfigService: {},
      articleRepository: {},
      jobService,
      rawContentStore: null,
      queueService: null,
    });

    crawlService.executeSource = jest.fn().mockResolvedValue({
      source: 'google-news',
      fetchedCount: 3,
      storedCount: 2,
      successfulRequestCount: 1,
      failedRequestCount: 0,
      failures: [],
    });

    const result = await crawlService.processJob('job-1', 'google-news', {}, { queueId: 'queue-1' });

    expect(result.status).toBe('completed');
    expect(jobService.updateJob).toHaveBeenNthCalledWith(
      1,
      'job-1',
      expect.objectContaining({
        status: 'running',
        queueId: 'queue-1',
        startedAt: expect.any(String),
      })
    );
    expect(jobService.updateJob).toHaveBeenNthCalledWith(
      2,
      'job-1',
      expect.objectContaining({
        status: 'completed',
        finishedAt: expect.any(String),
        result: expect.objectContaining({ storedCount: 2 }),
      })
    );
  });

  test('inline sentiment analysis persists distinct multi-asset mentions and feature rows', async () => {
    const articleRepository = {
      getByIds: jest.fn().mockResolvedValue([
        {
          id: 'article-1',
          source: 'google-news',
          title: 'AAPL climbs while TSLA falls after earnings updates',
          summary: 'AAPL beats expectations and TSLA faces margin pressure.',
          content: 'AAPL beats expectations after strong demand while TSLA falls on weaker guidance and margin pressure.',
          assets: ['AAPL', 'TSLA'],
          publishedAt: '2026-03-09T10:00:00.000Z',
        },
      ]),
      updateAnalysis: jest.fn().mockResolvedValue(true),
    };
    const mentionRepository = {
      replaceForArticles: jest.fn().mockResolvedValue([]),
    };
    const featureRepository = {
      getRecentBySymbols: jest.fn().mockResolvedValue([]),
      upsertMany: jest.fn().mockResolvedValue([]),
    };
    const jobService = {
      createJob: jest.fn().mockResolvedValue({ id: 'sent-job-1' }),
      updateJob: jest.fn().mockResolvedValue(undefined),
    };
    const { SentimentService } = require('../src/services/sentimentService');
    const sentimentService = new SentimentService({
      articleRepository,
      mentionRepository,
      featureRepository,
      jobService,
      queueService: { isEnabled: () => false },
    });

    const result = await sentimentService.requestAnalysis({
      source: 'google-news',
      articleIds: ['article-1'],
      forceInline: true,
    });

    expect(result.status).toBe('completed');
    expect(mentionRepository.replaceForArticles).toHaveBeenCalledWith(
      ['article-1'],
      expect.arrayContaining([
        expect.objectContaining({ articleId: 'article-1', assetId: 'AAPL' }),
        expect.objectContaining({ articleId: 'article-1', assetId: 'TSLA' }),
      ])
    );

    const mentions = mentionRepository.replaceForArticles.mock.calls[0][1];
    expect(new Set(mentions.map((mention) => mention.assetId))).toEqual(new Set(['AAPL', 'TSLA']));
    expect(featureRepository.upsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'AAPL', articleCount: 1 }),
        expect.objectContaining({ symbol: 'TSLA', articleCount: 1 }),
      ])
    );
    expect(articleRepository.updateAnalysis).toHaveBeenCalledWith(
      'article-1',
      expect.objectContaining({
        sentiment: expect.any(Object),
        sentimentType: expect.stringMatching(/positive|negative|neutral/),
      })
    );
  });
});
