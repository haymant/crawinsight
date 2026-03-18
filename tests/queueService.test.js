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

  test('registerSentimentWorker creates queue before working', async () => {
    const q = new QueueService(null);
    const calls = [];
    q.boss = {
      start: jest.fn().mockResolvedValue(undefined),
      createQueue: jest.fn().mockResolvedValue(undefined),
      work: jest.fn().mockResolvedValue(undefined),
    };

    await q.registerSentimentWorker((job) => calls.push(job));
    expect(q.boss.start).toHaveBeenCalled();
    expect(q.boss.createQueue).toHaveBeenCalledWith('sentiment-judge');
    expect(q.boss.work).toHaveBeenCalledWith('sentiment-judge', expect.any(Function));

    const handler = q.boss.work.mock.calls[0][1];
    const fakeJob = { id: '123', data: { foo: 'bar' } };
    await handler([fakeJob]);
    expect(calls).toEqual([fakeJob]);
  });

  test('publish uses configured pg-boss job options', async () => {
    process.env.CRAWLINSIGHT_JOB_EXPIRE_SECONDS = '123';
    process.env.CRAWLINSIGHT_JOB_RETRY_LIMIT = '2';
    process.env.CRAWLINSIGHT_JOB_RETRY_DELAY = '15';

    const q = new QueueService(null);
    q.boss = {
      start: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue('job-1'),
    };

    const id = await q.publish('sentiment-judge', { foo: 'bar' });
    expect(id).toBe('job-1');
    expect(q.boss.send).toHaveBeenCalledWith(
      'sentiment-judge',
      { foo: 'bar' },
      expect.objectContaining({ expireInSeconds: 123, retryLimit: 2, retryDelay: 15 })
    );

    delete process.env.CRAWLINSIGHT_JOB_EXPIRE_SECONDS;
    delete process.env.CRAWLINSIGHT_JOB_RETRY_LIMIT;
    delete process.env.CRAWLINSIGHT_JOB_RETRY_DELAY;
  });
});