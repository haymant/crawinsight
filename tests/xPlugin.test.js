const { getPlugin } = require('../src/plugins');

jest.setTimeout(90_000);

const useLiveX = Boolean(process.env.LIVE && process.env.X_USERNAME && process.env.X_PASSWORD);

describe('x plugin', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.MAX_REQUESTS_PER_SOURCE_MINUTE;
  });

  test('uses environment variable for throttle interval', () => {
    process.env.MAX_REQUESTS_PER_SOURCE_MINUTE = '12';
    jest.resetModules();
    const { X_REQUEST_INTERVAL_MS } = require('../src/plugins/x');
    expect(X_REQUEST_INTERVAL_MS).toBe(Math.ceil(60000 / 12));
  });

  test('expands account and tag placeholders and infers list ids', () => {
    const plugin = getPlugin('x');

    const accountRequests = plugin.expandRequests({
      urls: ['https://x.com/search?q=from%3A{account}%20filter%3Alinks&src=typed_query&f=live'],
      params: { accounts: ['markets', 'zerohedge'] },
    });

    expect(accountRequests.map((request) => request.url)).toEqual([
      'https://x.com/search?q=from%3Amarkets%20filter%3Alinks&src=typed_query&f=live',
      'https://x.com/search?q=from%3Azerohedge%20filter%3Alinks&src=typed_query&f=live',
    ]);
    expect(accountRequests.map((request) => request.metadata.account)).toEqual(['markets', 'zerohedge']);

    const listRequests = plugin.expandRequests({
      urls: ['https://x.com/i/lists/2030824480940146987'],
    });

    expect(listRequests[0].metadata.listId).toBe('2030824480940146987');
  });

  test('normalizes browser-extracted x items and enriches metadata', async () => {
    const plugin = getPlugin('x');
    const articles = await plugin.parse({
      body: [{
        title: '',
        link: 'https://x.com/markets/status/1912345678901234567',
        publishedAt: '2026-03-09T10:00:00.000Z',
        summary: 'Fed commentary is moving bond yields and bank stocks.',
        content: 'Fed commentary is moving bond yields and bank stocks.',
        author: 'Markets Desk',
        handle: '@markets',
        likeCount: 42,
        repostCount: 10,
        replyCount: 3,
      }],
      metadata: { listId: '2030824480940146987', tag: 'fed' },
    });

    expect(articles).toEqual([{
      title: 'Fed commentary is moving bond yields and bank stocks.',
      link: 'https://x.com/markets/status/1912345678901234567',
      publishedAt: '2026-03-09T10:00:00.000Z',
      summary: 'Fed commentary is moving bond yields and bank stocks.',
      content: 'Fed commentary is moving bond yields and bank stocks.',
      author: 'Markets Desk',
      handle: 'markets',
      listId: '2030824480940146987',
      account: null,
      tag: 'fed',
      likeCount: 42,
      repostCount: 10,
      replyCount: 3,
    }]);
  });

  (useLiveX ? test : test.skip)('fetches a live x list or reports a clear auth/access failure', async () => {
    const plugin = getPlugin('x');

    try {
      const items = await plugin.fetchWithBrowser('https://x.com/i/lists/2030824480940146987', {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      });

      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].link).toContain('/status/');
    } catch (error) {
      expect(error.message).toMatch(/authentication|login|challenge|parseable|redirected|unavailable/i);
    }
  });
});