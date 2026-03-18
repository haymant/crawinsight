const { DepthController } = require('../src/services/depthController');

describe('DepthController', () => {
  const controller = new DepthController();

  test('blocks depth-2 follow when max depth is reached', () => {
    const result = controller.evaluate({
      article: { link: 'https://example.com/story', crawlDepth: 1 },
      source: {},
      maxCrawlDepth: 1,
    });

    expect(result).toEqual({ allowed: false, reason: 'max-depth', keywordsMatched: [] });
  });

  test('blocks depth-2 follow when there is no link', () => {
    const result = controller.evaluate({
      article: { crawlDepth: 1, title: 'Oil jumps' },
      source: {},
      maxCrawlDepth: 2,
    });

    expect(result).toEqual({ allowed: false, reason: 'no-link', keywordsMatched: [] });
  });

  test('blocks depth-2 follow when relevance keywords miss', () => {
    const result = controller.evaluate({
      article: {
        link: 'https://example.com/story',
        crawlDepth: 1,
        title: 'Retail sales surprise',
        summary: 'Consumer spending rose',
      },
      source: { options: { relevanceKeywords: ['oil', 'tanker'] } },
      maxCrawlDepth: 2,
    });

    expect(result).toEqual({ allowed: false, reason: 'keyword-miss', keywordsMatched: [] });
  });

  test('allows depth-2 follow when relevance keywords match', () => {
    const result = controller.evaluate({
      article: {
        link: 'https://example.com/story',
        crawlDepth: 1,
        title: 'Oil surges on Hormuz disruption',
        summary: 'Tanker insurance spikes after Iran conflict.',
      },
      source: { options: { relevanceKeywords: ['oil', 'tanker'] } },
      maxCrawlDepth: 2,
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
    expect(result.keywordsMatched).toEqual(expect.arrayContaining(['oil', 'tanker']));
  });
});