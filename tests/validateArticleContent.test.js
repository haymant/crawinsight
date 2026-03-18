const { validateArticleContent } = require('../src/utils/validateArticleContent');

describe('validateArticleContent', () => {
  test('accepts article-like HTML that matches the RSS title and keywords', () => {
    const html = `
      <html>
        <head><title>Stocks slip, dollar strong as Iran conflict pushes oil prices higher - Reuters</title></head>
        <body>
          <article>
            <p>Stocks slip as investors react to Iran conflict and higher oil prices across global markets.</p>
            <p>Oil prices rose sharply while the dollar stayed firm and traders adjusted rate expectations.</p>
            <p>Market participants said the move hit stocks, bonds and commodities in broad risk-off trading.</p>
            <p>${'Detailed market coverage '.repeat(40)}</p>
          </article>
        </body>
      </html>
    `;

    const result = validateArticleContent({
      body: html,
      contentType: 'text/html; charset=utf-8',
      parentTitle: 'Stocks slip, dollar strong as Iran conflict pushes oil prices higher - Reuters',
      parentSummary: 'Oil prices and markets react to conflict.',
    });

    expect(result.isValid).toBe(true);
    expect(result.reason).toBe('valid');
    expect(result.titleSimilarity).toBeGreaterThanOrEqual(0.75);
    expect(result.keywordMatches).toBeGreaterThanOrEqual(3);
  });

  test('rejects a block page', () => {
    const html = '<html><head><title>Just a moment...</title></head><body>Cloudflare verification required. Verify you are human.</body></html>';

    const result = validateArticleContent({
      body: html,
      contentType: 'text/html; charset=utf-8',
      parentTitle: 'Fed officials signal slower pace of cuts - Reuters',
      parentSummary: 'Fed and rates in focus.',
    });

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('blocked-page');
  });
});