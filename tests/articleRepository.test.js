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
});
