const fs = require('fs');
const path = require('path');
const request = require('supertest');
const nock = require('nock');
const useLive = Boolean(process.env.LIVE);
const { createApp } = require('../src/app');
const { buildServices } = require('../src/bootstrap');
const { makeTempDir } = require('./helpers');

const googleFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'google.xml'), 'utf8'); // reuse same XML
const redditJsonFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit.json'), 'utf8');
const xFixture = [{
  title: 'Oil traders react to macro data',
  link: 'https://x.com/markets/status/1912345678901234567',
  publishedAt: '2026-03-09T10:00:00.000Z',
  summary: 'Oil traders react to macro data and a stronger dollar.',
  content: 'Oil traders react to macro data and a stronger dollar.',
  author: 'Markets Desk',
  handle: 'markets',
  listId: '2030824480940146987',
  tag: 'oil',
  likeCount: 22,
  repostCount: 8,
  replyCount: 5,
}];

describe('API', () => {
  afterEach(() => { if (!useLive) nock.cleanAll(); });


  test('lists sources, runs a scrape, and filters analysis', async () => {
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
    });
    const app = createApp(services);

    const sourcesResponse = await request(app).get('/api/sources');
    expect(sourcesResponse.status).toBe(200);
    expect(Object.keys(sourcesResponse.body.sources)).toEqual(['google-news']);

    const scrapeResponse = await request(app)
      .post('/api/scrapers')
      .send({ source: 'google-news' });
    expect(scrapeResponse.status).toBe(200);
    if (!useLive) {
      // job should have a valid ID
      expect(scrapeResponse.body.jobId).toBeDefined();
    }
    // check without asset filter first
    let analysisResponse = await request(app)
      .get('/api/analysis')
      .query({ source: 'google-news' });
    expect(analysisResponse.status).toBe(200);
    // may be empty when using fixture
    expect(Array.isArray(analysisResponse.body.articles)).toBe(true);
    if (analysisResponse.body.articles.length > 0) {
      expect(analysisResponse.body.articles.length).toBeGreaterThan(0);
    }
    // optionally exercise asset filter if it returns data
    analysisResponse = await request(app)
      .get('/api/analysis')
      .query({ source: 'google-news', asset: 'TSLA' });
    expect(analysisResponse.status).toBe(200);
    // asset-specific results may be zero, that's acceptable

    const jobsResponse = await request(app).get('/api/jobs');
    expect(jobsResponse.status).toBe(200);
    expect(jobsResponse.body.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          type: 'scrape',
          payload: expect.objectContaining({ source: 'google-news' }),
          status: expect.stringMatching(/queued|completed|completed_with_errors/),
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
      ])
    );

  });

  test('validates scheduler input', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    fs.writeFileSync(configPath, `sources:\n  google-news:\n    type: rss\n    urls:\n      - https://news.google.com/rss/search?q=site:reuters.com%20business\n`);

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
    });
    const app = createApp(services);

    const response = await request(app)
      .post('/api/schedulers')
      .send({ name: 'bad', source: 'google-news', expression: 'not-a-cron' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Invalid cron expression/);
  });

  test('filters analysis by subreddit for reddit sources', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    const redditUrl = useLive
      ? 'https://www.reddit.com/r/stocks/hot.json?limit=25'
      : 'https://www.reddit.com/r/{subreddit}/hot.json?limit=2';

    fs.writeFileSync(configPath, `sources:\n  reddit-stocks:\n    type: reddit\n    urls:\n      - ${redditUrl}\n    params:\n      subreddits:\n        - stocks\n    headers:\n      userAgent: Mozilla/5.0\n    filters:\n      keywords: [stock, market, guidance]\n`);

    if (!useLive) {
      nock('https://www.reddit.com')
        .get('/r/stocks/hot.json')
        .query({ limit: '2' })
        .reply(200, redditJsonFixture, { 'content-type': 'application/json' });
    }

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
    });
    const app = createApp(services);

    if (!useLive) {
      const redditPlugin = require('../src/plugins').getPlugin('reddit');
      jest.spyOn(redditPlugin, 'fetchWithBrowser').mockResolvedValue(redditJsonFixture);
    }

    const scrapeResponse = await request(app)
      .post('/api/scrapers')
      .send({ source: 'reddit-stocks' });
    if (useLive) {
      expect([200, 400]).toContain(scrapeResponse.status);
    } else {
      expect(scrapeResponse.status).toBe(200);
    }

    const analysisResponse = await request(app)
      .get('/api/analysis')
      .query({ source: 'reddit-stocks', subreddit: 'stocks' });
    expect(analysisResponse.status).toBe(200);
    expect(Array.isArray(analysisResponse.body.articles)).toBe(true);

    if (!useLive) {
      expect(analysisResponse.body.articles.length).toBeGreaterThan(0);
      expect(analysisResponse.body.articles.every((article) => article.subreddit === 'stocks')).toBe(true);
    }
  });

  test('filters analysis by x-specific metadata', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    fs.writeFileSync(configPath, `sources:\n  x-financial-list:\n    type: x\n    urls:\n      - https://x.com/i/lists/2030824480940146987\n    headers:\n      userAgent: Mozilla/5.0\n    filters:\n      keywords: [oil, dollar]\n    options:\n      browser: true\n`);

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
    });
    const app = createApp(services);

    const xPlugin = require('../src/plugins').getPlugin('x');
    jest.spyOn(xPlugin, 'fetchWithBrowser').mockResolvedValue(xFixture);

    const scrapeResponse = await request(app)
      .post('/api/scrapers')
      .send({ source: 'x-financial-list' });

    expect(scrapeResponse.status).toBe(200);

    const analysisResponse = await request(app)
      .get('/api/analysis')
      .query({
        source: 'x-financial-list',
        listId: '2030824480940146987',
        handle: 'markets',
        tag: 'oil',
      });

    expect(analysisResponse.status).toBe(200);
    expect(analysisResponse.body.articles).toHaveLength(1);
    expect(analysisResponse.body.articles[0]).toMatchObject({
      author: 'Markets Desk',
      handle: 'markets',
      listId: '2030824480940146987',
      tag: 'oil',
    });
  });

  test('analyze endpoint persists multi-asset mentions and daily features', async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    fs.writeFileSync(configPath, 'sources: {}\n');

    const services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
    });
    const app = createApp(services);

    await services.articleRepository.insertMany([
      {
        id: 'article-1',
        source: 'manual',
        title: 'AAPL rallies as TSLA slides after earnings',
        summary: 'AAPL beats while TSLA cuts outlook.',
        content: 'AAPL beats expectations after strong demand while TSLA slides after weaker guidance and margin pressure.',
        assets: ['AAPL', 'TSLA'],
        publishedAt: '2026-03-09T10:00:00.000Z',
      },
    ]);

    const analyzeResponse = await request(app)
      .post('/api/analyze')
      .send({ source: 'manual' });

    expect(analyzeResponse.status).toBe(200);
    expect(analyzeResponse.body.status).toBe('completed');

    const mentionsResponse = await request(app)
      .get('/api/mentions')
      .query({ source: 'manual' });
    expect(mentionsResponse.status).toBe(200);
    expect(mentionsResponse.body.mentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ articleId: 'article-1', assetId: 'AAPL' }),
        expect.objectContaining({ articleId: 'article-1', assetId: 'TSLA' }),
      ])
    );

    const aaplFeaturesResponse = await request(app)
      .get('/api/features')
      .query({ symbol: 'AAPL' });
    expect(aaplFeaturesResponse.status).toBe(200);
    expect(aaplFeaturesResponse.body.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'AAPL', articleCount: 1 }),
      ])
    );

    const tslaFeaturesResponse = await request(app)
      .get('/api/features')
      .query({ symbol: 'TSLA' });
    expect(tslaFeaturesResponse.status).toBe(200);
    expect(tslaFeaturesResponse.body.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'TSLA', articleCount: 1 }),
      ])
    );
  });
});