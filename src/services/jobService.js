const { desc, eq } = require('drizzle-orm');
const { crawlinsight_jobs } = require('../schema');

function toIsoString(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  return null;
}

function toJobRecord(row) {
  if (!row) {
    return null;
  }

  if ('id' in row) {
    return {
      ...row,
      createdAt: toIsoString(row.createdAt),
      updatedAt: toIsoString(row.updatedAt),
      startedAt: toIsoString(row.startedAt),
      finishedAt: toIsoString(row.finishedAt),
      queueId: row.queueId || null,
      error: row.error || null,
      result: row.result || null,
    };
  }

  return {
    id: row.job_id,
    type: row.type,
    payload: row.payload || (row.source_name ? { source: row.source_name } : undefined),
    status: row.status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: toIsoString(row.started_at),
    finishedAt: toIsoString(row.finished_at),
    queueId: row.queue_id || null,
    error: row.error || null,
    result: row.result || null,
  };
}

function toDbPatch(patch) {
  const updates = {};

  if ('status' in patch) updates.status = patch.status;
  if ('result' in patch) updates.result = patch.result || null;
  if ('error' in patch) updates.error = patch.error || null;
  if ('queueId' in patch) updates.queue_id = patch.queueId || null;
  if ('queue_id' in patch) updates.queue_id = patch.queue_id || null;
  if ('createdAt' in patch) updates.created_at = toIsoString(patch.createdAt);
  if ('updatedAt' in patch) updates.updated_at = toIsoString(patch.updatedAt);
  if ('startedAt' in patch) updates.started_at = toIsoString(patch.startedAt);
  if ('finishedAt' in patch) updates.finished_at = toIsoString(patch.finishedAt);

  return updates;
}

function withLifecycleTimestamps(patch) {
  const normalizedPatch = { ...patch, updatedAt: new Date().toISOString() };

  if (normalizedPatch.status === 'running' && !normalizedPatch.startedAt) {
    normalizedPatch.startedAt = normalizedPatch.updatedAt;
  }

  if (
    ['completed', 'completed_with_errors', 'failed'].includes(normalizedPatch.status) &&
    !normalizedPatch.finishedAt
  ) {
    normalizedPatch.finishedAt = normalizedPatch.updatedAt;
  }

  return normalizedPatch;
}

function getRawQueryClient(db) {
  if (!db) {
    return null;
  }

  if (typeof db.$client?.query === 'function') {
    return db.$client;
  }

  if (typeof db.session?.client?.query === 'function') {
    return db.session.client;
  }

  return null;
}

class JobService {
  constructor(dbClient = null) {
    // if a Drizzle-style database client is provided we persist jobs there,
    // otherwise fall back to in‑memory array for tests and lightweight uses.
    this.db = dbClient;
    this.jobs = [];
  }

  async createJob(type, payload) {
    const generatedId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();

    const job = {
      id: generatedId,
      type,
      payload,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      queueId: null,
      error: null,
      result: null,
    };

    if (this.db) {
      try {
        const safePayload = payload ? JSON.parse(JSON.stringify(payload)) : null;
        const rawClient = getRawQueryClient(this.db);

        const insertRow = {
          job_id: job.id,
          source_name: safePayload?.source || 'system',
          type: job.type,
          payload: safePayload,
          status: job.status,
          created_at: now,
          updated_at: now,
        };

        if (rawClient) {
          await rawClient.query(
            `INSERT INTO crawlinsight_jobs (job_id, source_name, type, payload, status, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              insertRow.job_id,
              insertRow.source_name,
              insertRow.type,
              insertRow.payload,
              insertRow.status,
              insertRow.created_at,
              insertRow.updated_at,
            ]
          );
        } else if (typeof this.db.insert === 'function') {
          await this.db.insert(crawlinsight_jobs).values(insertRow);
        } else if (typeof this.db.execute === 'function') {
          // fallback for test mocks
          await this.db.execute(
            `INSERT INTO crawlinsight_jobs (job_id, source_name, type, payload, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              insertRow.job_id,
              insertRow.source_name,
              insertRow.type,
              insertRow.payload,
              insertRow.status,
              insertRow.created_at,
              insertRow.updated_at,
            ]
          );
        }
      } catch (e) {
        console.error('failed to persist job', e);
        if (process.env.DEBUG_CRAWLINSIGHT) {
          console.error('persist job payload:', {
            jobId: job.id,
            created_at: now,
            updated_at: now,
            payloadKeys: job.payload ? Object.keys(job.payload) : null,
          });
        }
      }
    }

    this.jobs = [job, ...this.jobs.filter((entry) => entry.id !== job.id)];
    return job;
  }

  async updateJob(id, patch) {
    const patchWithTime = withLifecycleTimestamps(patch);

    let job = this.jobs.find((entry) => entry.id === id);
    if (!job && this.db) {
      // try load from db
      job = await this.getJob(id);
    }
    if (!job) {
      return null;
    }

    Object.assign(job, patchWithTime);
    this.jobs = [job, ...this.jobs.filter((entry) => entry.id !== id)];

    if (this.db) {
      const updates = toDbPatch(patchWithTime);
      const rawClient = getRawQueryClient(this.db);

      try {
        if (process.env.DEBUG_CRAWLINSIGHT) {
          console.error('JobService.updateJob updates:', updates);
        }

        if (rawClient) {
          const columns = Object.keys(updates);
          const values = columns.map((key) => updates[key]);
          const assignments = columns.map((column, idx) => `${column} = $${idx + 1}`);
          const query = `UPDATE crawlinsight_jobs SET ${assignments.join(', ')} WHERE job_id = $${
            values.length + 1
          }`;
          await rawClient.query(query, [...values, id]);
        } else if (typeof this.db.update === 'function') {
          await this.db
            .update(crawlinsight_jobs)
            .set(updates)
            .where(eq(crawlinsight_jobs.job_id, id));
        } else if (typeof this.db.execute === 'function') {
          const columns = Object.keys(updates);
          const values = columns.map((key) => updates[key]);
          const assignments = columns.map((column, idx) => `${column} = $${idx + 1}`);
          const query = `UPDATE crawlinsight_jobs SET ${assignments.join(', ')} WHERE job_id = $${
            values.length + 1
          }`;
          await this.db.execute(query, [...values, id]);
        }
      } catch (e) {
        console.error('failed to update job in db', e);
        if (process.env.DEBUG_CRAWLINSIGHT) {
          console.error('update payload that failed:', updates);
        }
      }
    }

    return job;
  }

  async listJobs() {
    if (this.db) {
      if (typeof this.db.select === 'function') {
        const rows = await this.db.select().from(crawlinsight_jobs).orderBy(desc(crawlinsight_jobs.created_at));
        return rows.map(toJobRecord);
      }
      if (typeof this.db.execute === 'function') {
        const result = await this.db.execute(
          `SELECT * FROM crawlinsight_jobs ORDER BY created_at DESC`
        );
        return (result.rows || []).map(toJobRecord);
      }
    }
    return this.jobs;
  }

  async getJob(id) {
    if (this.db) {
      if (typeof this.db.select === 'function') {
        const rows = await this.db
          .select()
          .from(crawlinsight_jobs)
          .where(eq(crawlinsight_jobs.job_id, id));
        return toJobRecord(rows[0] || null);
      }
      if (typeof this.db.execute === 'function') {
        const result = await this.db.execute(`SELECT * FROM crawlinsight_jobs WHERE job_id = $1`, [id]);
        return toJobRecord((result.rows || [])[0] || null);
      }
    }
    return this.jobs.find((entry) => entry.id === id) || null;
  }
}

module.exports = { JobService };