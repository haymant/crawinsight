const fs = require('fs');
const path = require('path');
const { getPlugin } = require('../src/plugins');

const redditJsonFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit.json'), 'utf8'));
const redditRssFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit.xml'), 'utf8');

describe('reddit plugin', () => {
  test('uses environment variable for throttle interval', () => {
    process.env.MAX_REQUESTS_PER_SOURCE_MINUTE = '10';
    // reload plugin to recompute interval
    jest.resetModules();
    const plugin2 = require('../src/plugins').getPlugin('reddit');
    const { REDDIT_REQUEST_INTERVAL_MS } = require('../src/plugins/reddit');
    expect(REDDIT_REQUEST_INTERVAL_MS).toBe(Math.ceil(60000 / 10));
    delete process.env.MAX_REQUESTS_PER_SOURCE_MINUTE;
  });

  test('expands subreddit placeholders into distinct requests', () => {
    const plugin = getPlugin('reddit');
    const requests = plugin.expandRequests({
      urls: ['https://www.reddit.com/r/{subreddit}/hot.json?limit=25'],
      params: { subreddits: ['stocks', 'investing'] },
    });

    expect(requests.map((request) => request.url)).toEqual([
      'https://www.reddit.com/r/stocks/hot.json?limit=25',
      'https://www.reddit.com/r/investing/hot.json?limit=25',
    ]);
    expect(requests.map((request) => request.metadata.subreddit)).toEqual(['stocks', 'investing']);
  });

  test('parses reddit json listings into normalized articles', async () => {
    const plugin = getPlugin('reddit');
    const articles = await plugin.parse({
      body: redditJsonFixture,
      metadata: { subreddit: 'stocks' },
    });

    expect(articles).toHaveLength(2);
    expect(articles[0]).toMatchObject({
      title: 'AAPL earnings beat lifts market sentiment',
      subreddit: 'stocks',
      score: 842,
      commentCount: 134,
    });
    expect(articles[0].link).toContain('/r/stocks/comments/abc123/');
  });

  test('parses reddit rss feeds and enriches subreddit metadata', async () => {
    const plugin = getPlugin('reddit');
    const articles = await plugin.parse({
      body: redditRssFixture,
      metadata: { subreddit: 'stocks' },
    });

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      title: 'TSLA guidance worries hit stock discussion',
      subreddit: 'stocks',
      score: null,
      commentCount: null,
    });
  });

  test('accepts browser-scraped reddit items directly', async () => {
    const plugin = getPlugin('reddit');
    const articles = await plugin.parse({
      body: [{
        title: 'Fed outlook dominates the daily thread',
        link: 'https://www.reddit.com/r/stocks/comments/example/fed_outlook/',
        publishedAt: '2025-03-01T00:00:00.000Z',
        summary: 'Macro and rate-cut debate continue.',
        content: 'Macro and rate-cut debate continue.',
        subreddit: 'stocks',
        score: 100,
        commentCount: 20,
      }],
      metadata: { subreddit: 'stocks' },
    });

    expect(articles).toEqual([{ 
      title: 'Fed outlook dominates the daily thread',
      link: 'https://www.reddit.com/r/stocks/comments/example/fed_outlook/',
      publishedAt: '2025-03-01T00:00:00.000Z',
      summary: 'Macro and rate-cut debate continue.',
      content: 'Macro and rate-cut debate continue.',
      subreddit: 'stocks',
      score: 100,
      commentCount: 20,
    }]);
  });
});