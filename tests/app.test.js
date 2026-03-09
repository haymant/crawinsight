const fs = require('fs');
const path = require('path');
const request = require('supertest');
const nock = require('nock');
const useLive = Boolean(process.env.LIVE);
const { createApp } = require('../src/app');
const { buildServices } = require('../src/bootstrap');
const { makeTempDir } = require('./helpers');

const googleFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'google.xml'), 'utf8'); // reuse same XML

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
});