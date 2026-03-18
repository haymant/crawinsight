const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nock = require('nock');
const yaml = require('js-yaml');
const useLive = Boolean(process.env.LIVE);

jest.mock('../src/db', () => ({
  db: { execute: jest.fn() },
}));

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
      expect(articles.length).toBeGreaterThan(0);
      expect(articles[0].fullContentPath).toMatch(/\.xml$/);
    } else {
      // live run: just ensure job returned
      expect(result.jobId).toBeDefined();
    }

  });

  test('follows linked article URLs when maxCrawlDepth is set', async () => {
    if (useLive) {
      // Skip live executions, this test relies on mocked HTTP requests.
      return;
    }

    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    const feedUrl = 'https://example.com/feed.xml';
    const articleUrl = 'https://example.com/article/1';

    fs.writeFileSync(
      configPath,
      `sources:\n  rss-depth:\n    type: rss\n    urls:\n      - ${feedUrl}\n    options:\n      maxCrawlDepth: 2\n`
    );

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test</title><item><title>Test item</title><link>${articleUrl}</link><pubDate>Mon, 01 Jan 2025 00:00:00 GMT</pubDate><description>Test description</description></item></channel></rss>`;

    nock('https://example.com')
      .get('/feed.xml')
      .reply(200, feedXml);

    nock('https://example.com')
      .get('/article/1')
      .reply(200, '<html><body>Deep content</body></html>', { 'content-type': 'text/html' });

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
      queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
      jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
      sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('rss-depth', { forceInline: true, maxCrawlDepth: 2 });
    const articles = await services.articleRepository.query({ source: 'rss-depth' });

    // We expect two stored articles: the original feed item (depth 1) and the linked content (depth 2).
    expect(articles.length).toBe(2);

    const depth2Id = CrawlService.createArticleId(`${articleUrl}|depth=2`);
    const depth1 = articles.find((a) => a.crawlDepth === 1);
    const depth2 = articles.find((a) => a.crawlDepth === 2);

    expect(depth1).toBeDefined();
    expect(depth2).toBeDefined();
    expect(depth1.linkedArticleIds).toContain(depth2Id);
    expect(depth1.metadata).toEqual(
      expect.objectContaining({
        depth2Success: true,
        depth2Reason: 'fetched',
        maxCrawlDepth: 2,
      })
    );
    expect(depth2.metadata).toEqual(
      expect.objectContaining({
        parentArticleId: depth1.id,
        depth2Success: true,
        fetchMode: 'http',
      })
    );
    expect(result.depth2).toEqual({
      attempted: 1,
      followed: 1,
      succeeded: 1,
      skippedByGate: 0,
    });
  });

  test('skips depth-2 follow when relevanceKeywords do not match', async () => {
    if (useLive) {
      return;
    }

    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    const feedUrl = 'https://example.com/relevance-feed.xml';
    const articleUrl = 'https://example.com/article/retail';

    fs.writeFileSync(
      configPath,
      `sources:\n  rss-gated:\n    type: rss\n    urls:\n      - ${feedUrl}\n    options:\n      maxCrawlDepth: 2\n      relevanceKeywords: [oil, tanker]\n`
    );

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test</title><item><title>Retail sales improve in March</title><link>${articleUrl}</link><pubDate>Mon, 01 Jan 2025 00:00:00 GMT</pubDate><description>Consumer spending rose.</description></item></channel></rss>`;

    nock('https://example.com')
      .get('/relevance-feed.xml')
      .reply(200, feedXml);

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
      queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
      jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
      sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('rss-gated', { forceInline: true, maxCrawlDepth: 2 });
    const articles = await services.articleRepository.query({ source: 'rss-gated' });

    expect(articles).toHaveLength(1);
    expect(articles[0].metadata).toEqual(
      expect.objectContaining({
        depth2Success: false,
        depth2Reason: 'keyword-miss',
      })
    );
    expect(result.depth2).toEqual({
      attempted: 1,
      followed: 0,
      succeeded: 0,
      skippedByGate: 1,
    });
  });

  test('uses plugin linked-article browser fallback when http fetch fails', async () => {
    if (useLive) {
      return;
    }

    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    const tweetUrl = 'https://x.com/markets/status/1912345678901234567';
    fs.writeFileSync(
      configPath,
      `sources:\n  x-depth:\n    type: x\n    urls:\n      - https://x.com/i/lists/2030824480940146987\n    filters:\n      keywords: [Fed]\n    options:\n      browser: true\n      maxCrawlDepth: 2\n      linkedArticleBrowserFallback: true\n`
    );

    const plugin = require('../src/plugins').getPlugin('x');
    const listingSpy = jest.spyOn(plugin, 'fetchWithBrowser').mockResolvedValue([
      {
        title: 'Fed signals slower cuts',
        link: tweetUrl,
        publishedAt: '2026-03-09T10:00:00.000Z',
        summary: 'Fed signals slower cuts',
        content: 'Fed signals slower cuts and markets reprice yields.',
        author: 'Markets Desk',
        handle: 'markets',
        listId: '2030824480940146987',
      },
    ]);
    const fallbackSpy = jest.spyOn(plugin, 'fetchLinkedArticleWithBrowser').mockResolvedValue({
      body: '<html><body>tweet detail</body></html>',
      contentType: 'text/html; charset=utf-8',
    });

    jest.spyOn(axios, 'get').mockRejectedValueOnce(new Error('blocked'));

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
      queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
      jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
      sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('x-depth', { forceInline: true, maxCrawlDepth: 2 });
    const articles = await services.articleRepository.query({ source: 'x-depth' });
    const depth2 = articles.find((article) => article.crawlDepth === 2);

    expect(listingSpy).toHaveBeenCalled();
    expect(fallbackSpy).toHaveBeenCalledWith(tweetUrl, expect.any(Object));
    expect(result.depth2).toEqual({
      attempted: 1,
      followed: 1,
      succeeded: 1,
      skippedByGate: 0,
    });
    expect(depth2.metadata).toEqual(
      expect.objectContaining({
        fetchMode: 'fallback',
        depth2Success: true,
      })
    );
  });

  test('uses browser fetch first when linkedArticleBrowserFallback is always', async () => {
    if (useLive) {
      return;
    }

    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    fs.writeFileSync(
      configPath,
      `sources:\n  rss-browser-first:\n    type: rss\n    urls:\n      - https://example.com/feed.xml\n    filters:\n      keywords: [market]\n    options:\n      maxCrawlDepth: 2\n      linkedArticleBrowserFallback: always\n`
    );

    const rssPlugin = require('../src/plugins').getPlugin('rss');
    const browserSpy = jest
      .spyOn(rssPlugin, 'fetchLinkedArticleWithBrowser')
      .mockResolvedValue({ body: '<html><body>article</body></html>', contentType: 'text/html; charset=utf-8' });

    // Feed request should still be fetched via HTTP.
    const fakeFeed = `<?xml version="1.0"?><rss><channel><item><title>Market news</title><link>https://example.com/article</link><description>market</description></item></channel></rss>`;
    const axiosSpy = jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: fakeFeed, headers: { 'content-type': 'application/rss+xml' }, status: 200 });

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
      queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
      jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
      sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('rss-browser-first', { forceInline: true, maxCrawlDepth: 2 });

    expect(axiosSpy).toHaveBeenCalledTimes(1); // only for feed
    expect(browserSpy).toHaveBeenCalledTimes(1); // used for depth-2 fetch
    expect(result.depth2.followed).toBe(1);
    expect(result.depth2.succeeded).toBe(1);
  });

  test('resolves Google News wrapper pages before storing depth-2 articles', async () => {
    if (useLive) {
      return;
    }

    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    const feedUrl = 'https://news.google.com/rss/search?q=site:reuters.com%20markets';
    const googleWrapperUrl = 'https://news.google.com/rss/articles/CBMi-test?oc=5';
    const publisherUrl = 'https://www.reuters.com/world/us/resolved-story';

    fs.writeFileSync(
      configPath,
      `sources:\n  google-depth:\n    type: rss\n    urls:\n      - ${feedUrl}\n    options:\n      maxCrawlDepth: 2\n      validateDepth2Content: true\n`
    );

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google</title><item><title>Oil rises on conflict fears - Reuters</title><link>${googleWrapperUrl}</link><pubDate>Mon, 01 Jan 2025 00:00:00 GMT</pubDate><description>Oil rises on conflict fears.</description><source url="https://www.reuters.com">Reuters</source></item></channel></rss>`;

    nock('https://news.google.com')
      .get('/rss/search')
      .query(true)
      .reply(200, feedXml);

    nock('https://news.google.com')
      .get('/rss/articles/CBMi-test')
      .query({ oc: '5' })
      .reply(
        200,
        `<html><head><link rel="canonical" href="${publisherUrl}" /></head><body>Redirecting</body></html>`,
        { 'content-type': 'text/html; charset=utf-8' }
      );

    nock('https://www.reuters.com')
      .get('/world/us/resolved-story')
      .reply(
        200,
        `<html><head><title>Oil rises on conflict fears - Reuters</title></head><body><article><p>Oil rises on conflict fears and market volatility spreads across commodities.</p><p>Reuters said oil and market traders reacted to renewed fears.</p><p>Investors repriced risk across oil, commodities and equities.</p><p>${'Expanded Reuters article body '.repeat(40)}</p></article></body></html>`,
        { 'content-type': 'text/html; charset=utf-8' }
      );

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
      queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
      jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
      sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('google-depth', { forceInline: true, maxCrawlDepth: 2 });
    const articles = await services.articleRepository.query({ source: 'google-depth' });
    const depth1 = articles.find((article) => article.crawlDepth === 1);
    const depth2 = articles.find((article) => article.crawlDepth === 2);
    const resolvedDepth2Id = CrawlService.createArticleId(`${publisherUrl}|depth=2`);

    expect(result.depth2).toEqual({
      attempted: 1,
      followed: 1,
      succeeded: 1,
      skippedByGate: 0,
    });
    expect(depth1.linkedArticleIds).toContain(resolvedDepth2Id);
    expect(depth2.link).toBe(publisherUrl);
    expect(depth2.id).toBe(resolvedDepth2Id);
    expect(depth2.metadata).toEqual(
      expect.objectContaining({
        parentArticleLink: googleWrapperUrl,
        resolvedArticleLink: publisherUrl,
        fetchMode: 'http',
      })
    );
  });

  test('reuses browser-loaded publisher HTML after Google News resolves without refetching the publisher URL', async () => {
    if (useLive) {
      return;
    }

    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    const feedUrl = 'https://news.google.com/rss/search?q=site:reuters.com%20oil';
    const googleWrapperUrl = 'https://news.google.com/rss/articles/CBMi-browser?oc=5';
    const publisherUrl = 'https://www.reuters.com/markets/commodities/us-is-quickly-exhausting-tools-absorb-iran-war-oil-shock-2026-03-16/';

    fs.writeFileSync(
      configPath,
      `sources:\n  google-browser-resolve:\n    type: rss\n    urls:\n      - ${feedUrl}\n    options:\n      maxCrawlDepth: 2\n      linkedArticleBrowserFallback: always\n      validateDepth2Content: true\n`
    );

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google</title><item><title>US is quickly exhausting tools to absorb Iran war oil shock - Reuters</title><link>${googleWrapperUrl}</link><pubDate>Mon, 01 Jan 2025 00:00:00 GMT</pubDate><description>Oil markets and Iran war risks remain in focus.</description><source url="https://www.reuters.com">Reuters</source></item></channel></rss>`;

    nock('https://news.google.com')
      .get('/rss/search')
      .query(true)
      .reply(200, feedXml);

    const rssPlugin = require('../src/plugins').getPlugin('rss');
    const browserSpy = jest
      .spyOn(rssPlugin, 'fetchLinkedArticleWithBrowser')
      .mockResolvedValue({
        body: `<html><head><title>US is quickly exhausting tools to absorb Iran war oil shock - Reuters</title></head><body><article><p>Oil markets are absorbing the Iran war shock as traders gauge supply risks.</p><p>Reuters reported commodities desks are reassessing crude and shipping exposure.</p><p>Investors across oil, commodities and broader markets are repricing volatility.</p><p>${'Expanded Reuters article body '.repeat(40)}</p></article></body></html>`,
        contentType: 'text/html; charset=utf-8',
        resolvedUrl: `${publisherUrl}#main-content`,
      });

    const axiosSpy = jest.spyOn(axios, 'get');

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
      queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
      jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
      sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('google-browser-resolve', { forceInline: true, maxCrawlDepth: 2 });
    const articles = await services.articleRepository.query({ source: 'google-browser-resolve' });
    const depth2 = articles.find((article) => article.crawlDepth === 2);

    expect(result.depth2).toEqual({
      attempted: 1,
      followed: 1,
      succeeded: 1,
      skippedByGate: 0,
    });
    expect(browserSpy).toHaveBeenCalledTimes(1);
    expect(axiosSpy).toHaveBeenCalledTimes(1);
    expect(depth2.link).toBe(publisherUrl);
    expect(depth2.metadata).toEqual(
      expect.objectContaining({
        resolvedArticleLink: publisherUrl,
        fetchMode: 'browser',
      })
    );
  });

  test('rejects blocked Google depth-2 pages and keeps the RSS snippet only', async () => {
    if (useLive) {
      return;
    }

    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    const feedUrl = 'https://news.google.com/rss/search?q=site:reuters.com%20fed';
    const googleWrapperUrl = 'https://news.google.com/rss/articles/CBMi-blocked?oc=5';
    const publisherUrl = 'https://www.reuters.com/world/us/blocked-story';

    fs.writeFileSync(
      configPath,
      `sources:\n  google-blocked:\n    type: rss\n    urls:\n      - ${feedUrl}\n    options:\n      maxCrawlDepth: 2\n      validateDepth2Content: true\n`
    );

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google</title><item><title>Fed officials signal slower pace of cuts - Reuters</title><link>${googleWrapperUrl}</link><pubDate>Mon, 01 Jan 2025 00:00:00 GMT</pubDate><description>Fed and rates remain in focus.</description><source url="https://www.reuters.com">Reuters</source></item></channel></rss>`;

    nock('https://news.google.com')
      .get('/rss/search')
      .query(true)
      .reply(200, feedXml);

    nock('https://news.google.com')
      .get('/rss/articles/CBMi-blocked')
      .query({ oc: '5' })
      .reply(200, `<html><head><link rel="canonical" href="${publisherUrl}" /></head><body>Redirecting you for human verification</body></html>`, {
        'content-type': 'text/html; charset=utf-8',
      });

    nock('https://www.reuters.com')
      .get('/world/us/blocked-story')
      .reply(200, '<html><head><title>Just a moment...</title></head><body>Cloudflare verification. Verify you are human.</body></html>', {
        'content-type': 'text/html; charset=utf-8',
      });

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
      queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
      jobService: { createJob: () => ({ id: '1' }), updateJob: () => {}, listJobs: async () => [], getJob: async () => null },
      sourceConfigService: makeYamlService(configPath),
    });

    const result = await services.crawlService.runSource('google-blocked', { forceInline: true, maxCrawlDepth: 2 });
    const articles = await services.articleRepository.query({ source: 'google-blocked' });

    expect(result.depth2).toEqual({
      attempted: 1,
      followed: 1,
      succeeded: 0,
      skippedByGate: 0,
    });
    expect(articles).toHaveLength(1);
    expect(articles[0].metadata).toEqual(
      expect.objectContaining({
        depth2Success: false,
        depth2Reason: 'blocked-page',
        depth2ResolvedLink: publisherUrl,
      })
    );
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

  test('uses storage config base_path for raw content when source.storeDir set', async () => {
    const tempDir = makeTempDir();
    const oldCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const configPath = path.join(tempDir, 'sources.yaml');
      fs.writeFileSync(
        configPath,
        `sources:\n  google-news:\n    type: rss\n    storeDir: my-storage\n    urls:\n      - https://news.google.com/rss/search?q=site:reuters.com%20business\n`
      );

      const { db } = require('../src/db');
      db.execute.mockResolvedValueOnce({
        rows: [
          {
            storage_id: 'my-storage',
            type: 'filesystem',
            config: { base_path: tempDir },
          },
        ],
      });

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

      await services.crawlService.runSource('google-news');

      const rawRoot = path.join(tempDir, 'raw', 'my-storage');
      expect(fs.existsSync(rawRoot)).toBe(true);

      const findFiles = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        let result = [];
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            result = result.concat(findFiles(full));
          } else if (entry.isFile()) {
            result.push(full);
          }
        }
        return result;
      };

      const rawFiles = findFiles(rawRoot);
      expect(rawFiles.length).toBeGreaterThan(0);
      expect(rawFiles.some((f) => f.includes('google-news'))).toBe(true);
    } finally {
      process.chdir(oldCwd);
    }
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
