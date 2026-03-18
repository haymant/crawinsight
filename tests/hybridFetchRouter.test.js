const { HybridFetchRouter } = require('../src/services/hybridFetchRouter');

describe('HybridFetchRouter', () => {
  test('returns HTTP response on successful fetch', async () => {
    const router = new HybridFetchRouter({
      httpClient: {
        get: jest.fn().mockResolvedValue({
          status: 200,
          data: '<html>ok</html>',
          headers: { 'content-type': 'text/html' },
          request: { res: { responseUrl: 'https://example.com/story' } },
        }),
      },
    });

    const result = await router.fetch({ url: 'https://example.com/story' });

    expect(result).toEqual({
      body: '<html>ok</html>',
      contentType: 'text/html',
      fetchMode: 'http',
      resolvedUrl: 'https://example.com/story',
      status: 200,
    });
  });

  test('uses fallback fetcher on blocking status', async () => {
    const fallbackFetcher = jest.fn().mockResolvedValue({
      body: '<html>fallback</html>',
      contentType: 'text/html',
    });
    const router = new HybridFetchRouter({
      httpClient: {
        get: jest.fn().mockResolvedValue({
          status: 403,
          data: 'blocked',
          headers: { 'content-type': 'text/plain' },
        }),
      },
    });

    const result = await router.fetch({
      url: 'https://example.com/story',
      fallbackFetcher,
    });

    expect(fallbackFetcher).toHaveBeenCalledWith('https://example.com/story', {});
    expect(result).toEqual({
      body: '<html>fallback</html>',
      contentType: 'text/html',
      fetchMode: 'fallback',
      resolvedUrl: undefined,
      status: 403,
    });
  });

  test('uses fallback fetcher on network error', async () => {
    const fallbackFetcher = jest.fn().mockResolvedValue('<html>browser</html>');
    const router = new HybridFetchRouter({
      httpClient: {
        get: jest.fn().mockRejectedValue(new Error('network down')),
      },
    });

    const result = await router.fetch({
      url: 'https://example.com/story',
      headers: { 'user-agent': 'Mozilla/5.0' },
      fallbackFetcher,
    });

    expect(fallbackFetcher).toHaveBeenCalledWith('https://example.com/story', { 'user-agent': 'Mozilla/5.0' });
    expect(result).toEqual({
      body: '<html>browser</html>',
      contentType: undefined,
      fetchMode: 'fallback',
      resolvedUrl: undefined,
      status: null,
    });
  });
});