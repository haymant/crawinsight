const { QueueService } = require('../src/services/queueService');

describe('QueueService', () => {
  test('registerScrapeWorker creates queue before working', async () => {
    const q = new QueueService(null);
    const calls = [];
    q.boss = {
      start: jest.fn().mockResolvedValue(undefined),
      createQueue: jest.fn().mockResolvedValue(undefined),
      work: jest.fn().mockResolvedValue(undefined),
    };

    await q.registerScrapeWorker((job) => calls.push(job));
    expect(q.boss.start).toHaveBeenCalled();
    expect(q.boss.createQueue).toHaveBeenCalledWith('first-level-crawl');
    expect(q.boss.work).toHaveBeenCalledWith('first-level-crawl', expect.any(Function));

    // simulate pg-boss invoking the registered worker with an array
    const handler = q.boss.work.mock.calls[0][1];
    const fakeJob = { id: '123', data: { foo: 'bar' } };
    await handler([fakeJob]);
    expect(calls).toEqual([fakeJob]);
  });

  test('registerScrapeWorker swallows already-exists errors', async () => {
    const q = new QueueService(null);
    q.boss = {
      start: jest.fn().mockResolvedValue(undefined),
      createQueue: jest
        .fn()
        .mockRejectedValue(new Error('Queue already exists')),
      work: jest.fn().mockResolvedValue(undefined),
    };

    // should not throw
    await expect(q.registerScrapeWorker(() => {})).resolves.toBeUndefined();
    expect(q.boss.work).toHaveBeenCalled();
  });
});