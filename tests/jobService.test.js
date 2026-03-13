const { JobService } = require('../src/services/jobService');

function createBuilderDb() {
  const store = new Map();

  return {
    __store: store,
    insert: jest.fn(() => ({
      values: jest.fn(async (row) => {
        store.set(row.job_id, { ...row });
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn((updates) => ({
        where: jest.fn(async () => {
          const current = Array.from(store.values())[0];
          if (current) {
            store.set(current.job_id, { ...current, ...updates });
          }
        }),
      })),
    })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        orderBy: jest.fn(async () => Array.from(store.values())),
        where: jest.fn(async () => Array.from(store.values())),
      })),
    })),
  };
}

describe('JobService', () => {
  test('in-memory create/list/get/update works synchronously', async () => {
    const svc = new JobService(null);
    const job = await svc.createJob('scrape', { source: 'foo' });
    expect(job.id).toBeDefined();
    let jobs = await svc.listJobs();
    expect(jobs[0].id).toBe(job.id);
    const same = await svc.getJob(job.id);
    expect(same).toEqual(job);
    const updated = await svc.updateJob(job.id, { status: 'running' });
    expect(updated.status).toBe('running');
    expect(updated.startedAt).toEqual(expect.any(String));
  });

  test('db-backed builder service persists and returns canonical jobs', async () => {
    const fakeDb = createBuilderDb();
    const svc = new JobService(fakeDb);

    const job = await svc.createJob('scrape', { source: 'foo' });
    await svc.updateJob(job.id, { status: 'completed', result: { storedCount: 2 } });

    const list = await svc.listJobs();
    const single = await svc.getJob(job.id);

    expect(fakeDb.insert).toHaveBeenCalled();
    expect(fakeDb.update).toHaveBeenCalled();
    expect(list[0]).toMatchObject({
      id: job.id,
      type: 'scrape',
      payload: { source: 'foo' },
      status: 'completed',
      result: { storedCount: 2 },
    });
    expect(single).toMatchObject({
      id: job.id,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      finishedAt: expect.any(String),
    });
    expect(fakeDb.__store.get(job.id)).toMatchObject({
      job_id: job.id,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      finished_at: expect.any(String),
    });
  });

  test('db-backed raw execute fallback returns canonical jobs', async () => {
    const fakeDb = {
      execute: jest.fn().mockResolvedValue({
        rows: [{
          job_id: '123',
          type: 'scrape',
          payload: { source: 'foo' },
          source_name: 'foo',
          status: 'queued',
          created_at: '2026-03-13T10:00:00.000Z',
          updated_at: '2026-03-13T10:00:00.000Z',
        }],
      }),
    };

    const svc = new JobService(fakeDb);
    const job = await svc.createJob('scrape', { source: 'foo' });
    expect(fakeDb.execute).toHaveBeenCalled();
    await svc.updateJob(job.id, { status: 'failed', error: 'oops' });
    expect(fakeDb.execute).toHaveBeenCalled();
    const list = await svc.listJobs();
    expect(Array.isArray(list)).toBe(true);
    const single = await svc.getJob('123');
    expect(single.id).toBe('123');
    expect(single.payload).toEqual({ source: 'foo' });
  });

  test('db-backed raw pg client path bypasses drizzle timestamp mapping', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const fakeDb = {
      $client: { query },
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(async () => [{
            job_id: 'job-1',
            type: 'scrape',
            payload: { source: 'foo' },
            source_name: 'foo',
            status: 'queued',
            created_at: '2026-03-13 10:00:00.000',
            updated_at: '2026-03-13 10:00:00.000',
            started_at: null,
            finished_at: null,
            queue_id: null,
            error: null,
            result: null,
          }]),
        })),
      })),
    };

    const svc = new JobService(fakeDb);
    const created = await svc.createJob('scrape', { source: 'foo' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO crawlinsight_jobs'),
      expect.arrayContaining([created.id, 'foo', 'scrape'])
    );

    await svc.updateJob('job-1', { status: 'completed', result: { storedCount: 2 } });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crawlinsight_jobs SET'),
      expect.arrayContaining(['completed', { storedCount: 2 }, expect.any(String), expect.any(String), 'job-1'])
    );
  });
});
