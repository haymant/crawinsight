const { analyzeArticle, extractAssets, classifySentiment } = require('../src/services/analysisService');

describe('analysisService', () => {
  test('extracts uppercase tickers while filtering stop words', () => {
    expect(extractAssets('AAPL rallied while THE market sold off TSLA')).toEqual(['AAPL', 'TSLA']);
  });

  test('classifies VADER compound scores', () => {
    expect(classifySentiment(0.2)).toBe('positive');
    expect(classifySentiment(-0.2)).toBe('negative');
    expect(classifySentiment(0)).toBe('neutral');
  });

  test('marks transcript article relevant and carries explicit asset', () => {
    const analyzed = analyzeArticle(
      {
        title: 'Quarterly update',
        content: 'Revenue surged and guidance improved significantly.',
        summary: '',
        asset: 'AAPL',
      },
      {
        sourceName: 'seekingalpha',
        filters: { keywords: ['guidance'] },
      }
    );

    expect(analyzed.isRelevant).toBe(true);
    expect(analyzed.assets).toContain('AAPL');
    expect(analyzed.sentimentType).toBe('positive');
  });
});