class QueueService {
  constructor(connectionString) {
    this.connectionString = connectionString || null;
    this.boss = null;
    this.started = false;

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

  async publish(queueName, payload) {
    if (!this.boss) {
      return null;
    }

    await this.start();
    const id = await this.boss.send(queueName, payload);
    console.log(`published job to queue ${queueName}, pg-boss id`, id, 'payload', payload);
    return id;
  }

  async registerScrapeWorker(handler) {
    return this.registerWorker('first-level-crawl', handler);
  }

  async registerSentimentWorker(handler) {
    return this.registerWorker('sentiment-judge', handler);
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