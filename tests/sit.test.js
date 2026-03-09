const fs = require('fs');

// SIT tests may call live network and even launch a browser; give them more time
jest.setTimeout(30000);
const path = require('path');
const axios = require('axios');
const nock = require('nock');
const useLive = Boolean(process.env.LIVE);
const { createApp } = require('../src/app');
const { buildServices } = require('../src/bootstrap');
const { makeTempDir } = require('./helpers');

const googleFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'google.xml'), 'utf8');
  const bloombergFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'bloomberg.xml'), 'utf8');
  const nytimesFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'nytimes.xml'), 'utf8');
  const seekingAlphaFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'seekingalpha.xml'), 'utf8');
  const cnbcFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'cnbc.xml'), 'utf8');
  const redditFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit.json'), 'utf8');

function buildSourceDefinitions() {
  return {
    'google-news': {
      displayName: 'Google Financial News (Reuters links)',
      type: 'rss',
      urls: ['https://news.google.com/rss/search?q=site:reuters.com%20markets&hl=en-US&gl=US&ceid=US:en'],
      filters: { keywords: ['market', 'earnings', 'stock'] },
      options: { maxItemsPerFeed: 10 },
    },
    bloomberg: {
      displayName: 'Bloomberg',
      type: 'rss',
      urls: ['https://www.bloomberg.com/feeds/bbiz/sitemap_news.xml'],
      filters: { keywords: ['oil', 'energy', 'stocks'] },
      options: { maxItemsPerFeed: 10 },
    },
    nytimes: {
      displayName: 'New York Times',
      type: 'rss',
      urls: ['https://rss.nytimes.com/services/xml/rss/nyt/Business.xml'],
      filters: { keywords: ['market', 'inflation', 'economy'] },
      options: { maxItemsPerFeed: 10 },
    },
    seekingalpha: {
      displayName: 'Seeking Alpha',
      type: 'transcripts',
      urls: ['https://seekingalpha.com/symbol/{ticker}.xml'],
      params: { tickers: ['AAPL'] },
      filters: { keywords: ['guidance', 'revenue', 'margin'] },
      options: { maxItemsPerFeed: 10 },
    },
    cnbc: {
      displayName: 'CNBC',
      type: 'rss',
      urls: ['https://www.cnbc.com/id/100727362/device/rss/rss.html'],
      filters: { keywords: ['stocks', 'earnings', 'guidance'] },
      options: { maxItemsPerFeed: 10 },
    },
    'reddit-stocks': {
      displayName: 'Reddit Stocks',
      type: 'reddit',
      urls: [useLive ? 'https://www.reddit.com/r/stocks/hot.json?limit=25' : 'https://www.reddit.com/r/{subreddit}/hot.json?limit=25'],
      params: { subreddits: ['stocks'] },
      headers: { userAgent: 'Mozilla/5.0' },
      filters: { keywords: ['stock', 'market', 'earnings', 'guidance'] },
      options: { maxItemsPerFeed: 10, browser: true },
    },

  };
}

function mockFeeds() {
  if (useLive) return;
  nock('https://news.google.com')
    .get('/rss/search')
    .query(true)
    .reply(200, googleFixture);

  nock('https://www.bloomberg.com')
    .get('/feeds/bbiz/sitemap_news.xml')
    .reply(200, bloombergFixture);

  nock('https://rss.nytimes.com')
    .get('/services/xml/rss/nyt/Business.xml')
    .reply(200, nytimesFixture);

  nock('https://seekingalpha.com')
    .get('/symbol/AAPL.xml')
    .reply(200, seekingAlphaFixture);

  nock('https://www.cnbc.com')
    .get('/id/100727362/device/rss/rss.html')
    .reply(200, cnbcFixture);

  nock('https://www.reddit.com')
    .get('/r/stocks/hot.json')
    .query({ limit: '25' })
    .reply(200, redditFixture, { 'content-type': 'application/json' });

}

describe('REST SIT', () => {
  let server;
  let client;
  let services;

  beforeAll(async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    fs.writeFileSync(configPath, 'sources: {}\n');

    services = buildServices({
      configPath,
      dataPath: path.join(tempDir, 'articles.json'),
    });

    const app = createApp(services);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    const { port } = server.address();
    client = axios.create({
      baseURL: `http://127.0.0.1:${port}`,
      validateStatus: () => true,
    });
  });

  afterAll(async () => {
    services.schedulerService.stopAll();
    if (!useLive) nock.cleanAll();
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(() => { if (!useLive) nock.cleanAll(); });

  test('adds sources, runs scrapers, registers schedulers, verifies jobs, and exposes analysis', async () => {
    const sourceDefinitions = buildSourceDefinitions();

    for (const [name, config] of Object.entries(sourceDefinitions)) {
      const response = await client.post('/api/sources', { name, config });
      expect(response.status).toBe(201);
      expect(response.data.name).toBe(name);
    }

    const listResponse = await client.get('/api/sources');
    expect(listResponse.status).toBe(200);
    expect(Object.keys(listResponse.data.sources).sort()).toEqual(Object.keys(sourceDefinitions).sort());

    mockFeeds();

    const scrapeResults = {};
    // if we're mocking, stub browser fetch so playright isn't invoked
    if (!useLive) {
      const redditPlugin = require('../src/plugins').getPlugin('reddit');
      jest.spyOn(redditPlugin, 'fetchWithBrowser').mockResolvedValue(redditFixture);
    }

    for (const name of Object.keys(sourceDefinitions)) {
      const response = await client.post('/api/scrapers', { source: name });
      if (useLive) {
        expect([200, 400]).toContain(response.status);
      } else {
        expect(response.status).toBe(200);
      }
      scrapeResults[name] = response.data;
    }

    const schedulerRequests = [
      { name: 'hourly-google', source: 'google-news', expression: '0 * * * *' },
      { name: 'weekday-nyt', source: 'nytimes', expression: '15 9 * * 1-5' },
    ];

    for (const payload of schedulerRequests) {
      const response = await client.post('/api/schedulers', payload);
      expect(response.status).toBe(201);
      expect(response.data.name).toBe(payload.name);
    }

    const schedulesResponse = await client.get('/api/schedulers');
    expect(schedulesResponse.status).toBe(200);
    expect(schedulesResponse.data.schedules).toHaveLength(2);

    const jobsResponse = await client.get('/api/jobs');
    expect(jobsResponse.status).toBe(200);
    expect(jobsResponse.data.jobs).toHaveLength(Object.keys(sourceDefinitions).length);
    expect(jobsResponse.data.jobs.every((job) => job.status !== 'running' && job.status !== 'failed')).toBe(true);

    for (const name of Object.keys(sourceDefinitions)) {
      const analysisResponse = await client.get('/api/analysis', { params: { source: name } });
      expect(analysisResponse.status).toBe(200);
      // articles array may be empty with fixtures, but should be defined
      expect(Array.isArray(analysisResponse.data.articles)).toBe(true);
      if (analysisResponse.data.articles.length > 0) {
        for (const article of analysisResponse.data.articles) {
          expect(article.sentiment).toBeDefined();
          expect(typeof article.sentiment.compound).toBe('number');
          expect(article.sentimentType).toMatch(/positive|negative|neutral/);
        }
      }
      if (scrapeResults[name].source) {
        expect(scrapeResults[name].source).toBe(name);
      }
    }

    const redditAnalysisResponse = await client.get('/api/analysis', {
      params: { source: 'reddit-stocks', subreddit: 'stocks' },
    });
    expect(redditAnalysisResponse.status).toBe(200);
    expect(Array.isArray(redditAnalysisResponse.data.articles)).toBe(true);
    if (!useLive) {
      expect(redditAnalysisResponse.data.articles.length).toBeGreaterThan(0);
      expect(redditAnalysisResponse.data.articles.every((article) => article.subreddit === 'stocks')).toBe(true);
    }
  });
});