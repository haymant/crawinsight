const path = require('path');
const { makeTempDir } = require('./helpers');
const { ArticleRepository } = require('../src/storage/articleRepository');

describe('ArticleRepository', () => {
  test('file-based repository still works', async () => {
    const temp = makeTempDir();
    const repo = new ArticleRepository(path.join(temp, 'foo.json'));
    const inserted = await repo.insertMany([{ source: 'a', link: 'x', title: 't' }]);
    expect(inserted).toHaveLength(1);
    const articles = await repo.query({ source: 'a' });
    expect(articles).toHaveLength(1);
  });

  test('db-backed repository issues insert and query SQL', async () => {
    const calls = [];
    const fakeDb = { execute: jest.fn().mockResolvedValue({ rows: [] }) };
    const repo = new ArticleRepository({ db: fakeDb });
    const articles = [{ id: '1', source: 'foo', title: 'bar', link: 'u' }];
    const inserted = await repo.insertMany(articles);
    expect(inserted).toHaveLength(1);
    expect(fakeDb.execute).toHaveBeenCalled();
    // test query filter construction
    fakeDb.execute.mockResolvedValue({ rows: [{ source: 'foo' }] });
    const result = await repo.query({ source: 'foo' });
    expect(result.length).toBe(1);
  });

  test('raw pg client receives JSON-encoded arrays for jsonb columns', async () => {
    const captured = [];
    const fakeDb = { $client: { query: jest.fn((sql, params) => {
      captured.push(params);
      return Promise.resolve({ rows: [] });
    }) } };

    const repo = new ArticleRepository({ db: fakeDb });

    const article = {
      id: '1',
      source: 'foo',
      title: 'bar',
      link: 'u',
      assets: ['E5B'],
      linkedArticleIds: ['A'],
      metadata: { foo: 'bar' },
    };

    await repo.insertMany([article]);

    expect(captured).toHaveLength(1);
    const params = captured[0];

    // $14 is assets in the INSERT statement
    expect(typeof params[13]).toBe('string');
    expect(params[13]).toBe(JSON.stringify(['E5B']));

    // linked_article_ids should also be JSON encoded
    expect(typeof params[14]).toBe('string');
    expect(params[14]).toBe(JSON.stringify(['A']));

    // metadata should be JSON encoded too
    expect(typeof params[19]).toBe('string');
    expect(params[19]).toBe(JSON.stringify({ foo: 'bar' }));
  });

  test('Postgres array literal strings are converted to JSON arrays', async () => {
    const captured = [];
    const fakeDb = { $client: { query: jest.fn((sql, params) => {
      captured.push(params);
      return Promise.resolve({ rows: [] });
    }) } };

    const repo = new ArticleRepository({ db: fakeDb });

    const article = {
      id: '2',
      source: 'foo',
      title: 'bar',
      link: 'u',
      assets: '{"IEA","TSX"}',
      linkedArticleIds: '{"A"}',
      metadata: '{"foo":"bar"}',
    };

    await repo.insertMany([article]);

    expect(captured).toHaveLength(1);
    const params = captured[0];

    expect(params[13]).toBe(JSON.stringify(['IEA', 'TSX']));
    expect(params[14]).toBe(JSON.stringify(['A']));
    expect(params[19]).toBe(JSON.stringify({ foo: 'bar' }));
  });
});
