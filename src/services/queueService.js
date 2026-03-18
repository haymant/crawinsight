class QueueService {
  constructor(connectionString) {
    this.connectionString = connectionString || null;
    this.boss = null;
    this.started = false;

    // pg-boss defaults to a 30s job execution timeout, which is too low for
    // sentiment analysis jobs that may call LLMs or process large batches.
    // Allow operators to increase this via env vars (useful for long-running
    // jobs and local debugging).
    this.defaultJobOptions = {
      // expireInSeconds controls how long pg-boss will wait for the worker to
      // finish before marking the job as timed-out and retrying.
      expireInSeconds: Number(process.env.CRAWLINSIGHT_JOB_EXPIRE_SECONDS) || 600,
      // Allow jobs to retry once by default, with a short delay.
      retryLimit: Number(process.env.CRAWLINSIGHT_JOB_RETRY_LIMIT) || 1,
      retryDelay: Number(process.env.CRAWLINSIGHT_JOB_RETRY_DELAY) || 30,
    };

    if (this.connectionString) {
      // pg-boss ships as an ES module but exposes the class under
      // `PgBoss` when required from CommonJS.  The object returned by
      // `require` can look like:
      //   { PgBoss: [class PgBoss], … }
      // or in some environments it might have a default property.  To
      // be safe we pick whichever value is a constructor.
      const pgBossModule = require('pg-boss');
      const PgBoss =
        pgBossModule.PgBoss ||
        pgBossModule.default ||
        pgBossModule;
      this.boss = new PgBoss({ connectionString: this.connectionString });

      // log any internal errors instead of letting them bubble as
      // uncaught events; this keeps the host process alive and makes
      // debugging easier.
      this.boss.on('error', (err) => {
        console.error('pg-boss error:', err);
      });
    }
  }

  isEnabled() {
    return Boolean(this.boss);
  }

  async start() {
    if (!this.boss || this.started) {
      return;
    }

    console.log('starting pg-boss');
    await this.boss.start();
    this.started = true;
  }

  async stop() {
    if (!this.boss || !this.started) {
      return;
    }

    await this.boss.stop();
    this.started = false;
  }

  async publishScrapeJob(payload) {
    return this.publish('first-level-crawl', payload);
  }

  async publishSentimentJob(payload) {
    return this.publish('sentiment-judge', payload);
  }

  async publish(queueName, payload, options = {}) {
    if (!this.boss) {
      return null;
    }

    await this.start();
    const jobOptions = { ...this.defaultJobOptions, ...options };
    const id = await this.boss.send(queueName, payload, jobOptions);
    console.log(`published job to queue ${queueName}, pg-boss id`, id, 'payload', payload, 'options', jobOptions);
    return id;
  }

  async registerScrapeWorker(handler) {
    return this.registerWorker('first-level-crawl', handler);
  }

  async registerSentimentWorker(handler) {
    return this.registerWorker('sentiment-judge', handler);
  }

  async cancelJob(queueName, jobId) {
    if (!this.boss) {
      return false;
    }

    try {
      if (typeof this.boss.cancel === 'function') {
        await this.boss.cancel(queueName, jobId)
        return true
      }

      // pg-boss supports `cancel` and `abort`; try abort as a fallback.
      if (typeof this.boss.abort === 'function') {
        await this.boss.abort(queueName, jobId)
        return true
      }

      return false
    } catch (e) {
      console.error('failed to cancel pg-boss job', jobId, e)
      return false
    }
  }

  async registerWorker(queueName, handler) {
    if (!this.boss) {
      return;
    }

    await this.start();

    // pg-boss throws when a worker starts on a queue that hasn't been
    // created yet.  Create the queue proactively; if it already exists
    // the call is a no-op.
    try {
      await this.boss.createQueue(queueName);
    } catch (e) {
      // ignore "already exists" errors, log others for visibility
      if (!/already exists/.test(String(e))) {
        console.error('failed to create queue', e);
      }
    }

    await this.boss.work(queueName, async (jobs) => {
      // pg-boss may deliver a batch of jobs (array); always grab the first
      const job = Array.isArray(jobs) ? jobs[0] : jobs;
      console.log(`worker received job on ${queueName}`, job?.id, 'data', job?.data);
      await handler(job);
    });
  }
}

module.exports = { QueueService };