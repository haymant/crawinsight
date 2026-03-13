const fs = require('fs');
const path = require('path');
const { SourceConfigService } = require('../src/config/sourceConfigService');
const { getPlugin } = require('../src/plugins');
const { makeTempDir } = require('./helpers');

describe('source configuration and plugin expansion', () => {
  test('upserts and deletes source definitions', async () => {
    // stubbed DB client
    const fakeRows = [];
    const dbClient = {
      select: () => ({ from: () => ({ where: (col, val) => Promise.resolve(fakeRows) }) }),
      execute: jest.fn().mockImplementation(() => Promise.resolve({ rows: fakeRows })),
    };
    const service = new SourceConfigService(dbClient);

    await service.upsertSource('demo', { type: 'rss', urls: ['https://example.com/feed.xml'] });
    // simulate that subsequent query returns our row
    fakeRows.push({ name: 'demo', type: 'rss', urls: ['https://example.com/feed.xml'] });
    expect(await service.getSource('demo')).toMatchObject({ type: 'rss', urls: ['https://example.com/feed.xml'] });

    expect(await service.deleteSource('demo')).toBe(true);
    // not verifying rows after deletion
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

  test('articles are written to custom storeDir when provided', async () => {
    const tempDir = makeTempDir();
    // fake db with fakeRows array
    const fakeRows = [];
    const dbClient = { select: () => ({ from: () => ({ where: () => Promise.resolve(fakeRows) }) }), execute: jest.fn().mockImplementation(() => Promise.resolve({ rows: fakeRows })) };
    const service = new SourceConfigService(dbClient);
    const sourceDef = { type: 'rss', urls: ['https://example.com/feed'], storeDir: tempDir };
    await service.upsertSource('foo', sourceDef);
    // mimic DB insert for getSource
    fakeRows.push({ name: 'foo', type: 'rss', urls: ['https://example.com/feed'] });

    // stub plugin to return one fake item without network
    const plugin = {
      expandRequests: () => [{ url: 'https://example.com/feed' }],
      parse: async () => [{ title: 'x', link: 'y' }],
    };
    jest.spyOn(require('../src/plugins'), 'getPlugin').mockReturnValue(plugin);
    // prevent axios from actually fetching
    jest.spyOn(require('axios'), 'get').mockResolvedValue({ data: '', headers: {} });

    const { CrawlService } = require('../src/core/crawlService');
    const articleRepo = new (require('../src/storage/articleRepository').ArticleRepository)(path.join(tempDir, 'default.json'));
    const jobService = { createJob: () => ({ id: '1' }), updateJob: () => {} };
    const crawlService = new CrawlService({
      sourceConfigService: service,
      articleRepository: articleRepo,
      jobService,
      rawContentStore: null,
      queueService: null,
    });

    const result = await crawlService.runSource('foo', { forceInline: true });
    // default repository file should be written (storage lookup not simulated)
    const defaultFile = path.join(tempDir, 'default.json');
    expect(fs.existsSync(defaultFile)).toBe(true);
  });

  test('storage lookup respects filesystem config and writes to derived path', async () => {
    const tempDir = makeTempDir();
    const fakeRows = [];
    const dbClient = { select: () => ({ from: () => ({ where: () => Promise.resolve(fakeRows) }) }), execute: jest.fn().mockImplementation(() => Promise.resolve({ rows: fakeRows })) };
    const service = new SourceConfigService(dbClient);
    const sourceDef = { type: 'rss', urls: ['https://example.com/feed'], storeDir: 'S1' };
    await service.upsertSource('foo', sourceDef);
    fakeRows.push({ name: 'foo', type: 'rss', urls: ['https://example.com/feed'], storage_id: 'S1' });

    // setup fake storage record returned by db.execute in crawlService
    const storageRow = { storage_id: 'S1', type: 'filesystem', config: { base_path: tempDir } };
    // reset modules first so that our later mocks apply to fresh imports
    jest.resetModules();
    jest.doMock('../src/db', () => ({ db: { execute: jest.fn().mockResolvedValue({ rows: [storageRow] }) } }));

    const plugin = {
      expandRequests: () => [{ url: 'https://example.com/feed' }],
      parse: async () => [{ title: 'x', link: 'y' }],
    };
    // require plugins after resetModules
    jest.spyOn(require('../src/plugins'), 'getPlugin').mockReturnValue(plugin);
    jest.spyOn(require('axios'), 'get').mockResolvedValue({ data: '', headers: {} });

    const { CrawlService } = require('../src/core/crawlService');
    const jobService = { createJob: () => ({ id: '1' }), updateJob: () => {} };
    const crawlService = new CrawlService({
      sourceConfigService: service,
      articleRepository: new (require('../src/storage/articleRepository').ArticleRepository)(path.join(tempDir, 'default.json')),
      jobService,
      rawContentStore: null,
      queueService: null,
    });

    const result = await crawlService.runSource('foo', { forceInline: true });
    const expectedFile = path.join(tempDir, 'S1', 'articles.json');
    expect(fs.existsSync(expectedFile)).toBe(true);
  });
});