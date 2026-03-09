const fs = require('fs');
const path = require('path');
const { SourceConfigService } = require('../src/config/sourceConfigService');
const { getPlugin } = require('../src/plugins');
const { makeTempDir } = require('./helpers');

describe('source configuration and plugin expansion', () => {
  test('upserts and deletes source definitions', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'sources.yaml');
    const service = new SourceConfigService(configPath);

    service.upsertSource('demo', { type: 'rss', urls: ['https://example.com/feed.xml'] });
    expect(service.getSource('demo')).toEqual({ type: 'rss', urls: ['https://example.com/feed.xml'] });

    expect(service.deleteSource('demo')).toBe(true);
    expect(service.getSource('demo')).toBeUndefined();
    expect(fs.existsSync(configPath)).toBe(true);
  });

  test('expands placeholder feed URLs for transcript sources', () => {
    const plugin = getPlugin('transcripts');
    const requests = plugin.expandRequests({
      urls: ['https://seekingalpha.com/symbol/{ticker}.xml'],
      params: { tickers: ['AAPL', 'TSLA'] },
    });

    expect(requests.map((request) => request.url)).toEqual([
      'https://seekingalpha.com/symbol/AAPL.xml',
      'https://seekingalpha.com/symbol/TSLA.xml',
    ]);
  });
});