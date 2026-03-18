const express = require('express');

// swagger removed per user request; documentation is maintained separately if needed

function createApp({ sourceConfigService, crawlService, jobService, schedulerService, articleRepository, mentionRepository, featureRepository, sentimentService, queueService }) {
  const app = express();
  app.use(express.json());

  const validateSourceConfig = (config) => {
    if (!config || typeof config !== 'object') {
      throw new Error('config object required');
    }
    ['filters', 'params', 'options'].forEach((k) => {
      if (k in config && config[k] != null && typeof config[k] !== 'object') {
        throw new Error(`${k} must be an object`);
      }
    });
  };


  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/sources', async (req, res) => {
    try {
      const sources = await sourceConfigService.listSources();
      res.json({ sources });
    } catch (err) {
      console.error('/api/sources error', err);
      res.status(500).json({ error: 'failed to fetch sources' });
    }
  });

  app.post('/api/sources', async (req, res) => {
    try {
      const { name, config } = req.body;
      if (!name || typeof name !== 'string') {
        throw new Error('name required');
      }
      validateSourceConfig(config);
      const source = await sourceConfigService.upsertSource(name, config);
      res.status(201).json({ name, source });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/sources/:name/session', async (req, res) => {
    try {
      const name = req.params.name;
      const session = req.body?.session;
      if (!session || typeof session !== 'object') {
        return res.status(400).json({ error: 'session object required' });
      }

      const source = await sourceConfigService.getSource(name);
      if (!source) {
        return res.status(404).json({ error: 'Source not found' });
      }

      await sourceConfigService.upsertSource(name, {
        ...source,
        options: {
          ...(source.options || {}),
          sessionState: session,
          useSession: true,
        },
      });

      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/sources/:name/session-status', async (req, res) => {
    try {
      const name = req.params.name;
      const status = await crawlService.checkSourceSession(name);
      res.json(status);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.put('/api/sources/:name', async (req, res) => {
    try {
      validateSourceConfig(req.body?.config);
      const source = await sourceConfigService.upsertSource(req.params.name, req.body.config);
      res.json({ name: req.params.name, source });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/api/sources/:name', async (req, res) => {
    const deleted = await sourceConfigService.deleteSource(req.params.name);
    if (!deleted) {
      return res.status(404).json({ error: 'Source not found' });
    }
    return res.status(204).send();
  });

  app.get('/api/scrapers', async (req, res) => {
    const jobs = await jobService.listJobs();
    res.json({ jobs });
  });

  app.post('/api/scrapers', async (req, res) => {
    try {
      const forceInline = req.body?.forceInline === true;
      const maxCrawlDepth = Number.isInteger(req.body?.maxCrawlDepth) ? req.body.maxCrawlDepth : undefined;
      const result = await crawlService.runSource(req.body.source, { forceInline, maxCrawlDepth });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/jobs', async (req, res) => {
    const jobs = await jobService.listJobs();
    res.json({ jobs });
  });

  app.get('/api/jobs/:id', async (req, res) => {
    const job = await jobService.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json(job);
  });

  app.post('/api/jobs/:id/stop', async (req, res) => {
    try {
      const jobId = req.params.id;
      const job = await jobService.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      const queueId = job.queueId || job.queue_id || null;
      if (!queueId) {
        return res.status(400).json({ error: 'Job is not queued or has no queue id' });
      }

      const queueName = job.type === 'sentiment' ? 'sentiment-judge' : 'first-level-crawl';
      const cancelled = await queueService.cancelJob(queueName, queueId);
      if (!cancelled) {
        return res.status(400).json({ error: 'Failed to cancel job' });
      }

      // Mark job as cancelled in the job table for visibility.
      await jobService.updateJob(jobId, { status: 'cancelled', error: 'Cancelled by user' });
      return res.json({ ok: true });
    } catch (error) {
      console.error('/api/jobs/:id/stop error', error);
      res.status(500).json({ error: 'Failed to stop job' });
    }
  });

  app.get('/api/schedulers', (req, res) => {
    res.json({ schedules: schedulerService.getSchedules() });
  });

  app.post('/api/schedulers', async (req, res) => {
    try {
      const schedule = await schedulerService.addSchedule({
        name: req.body.name,
        source: req.body.source,
        expression: req.body.expression,
      });
      res.status(201).json(schedule);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/api/schedulers/:name', (req, res) => {
    const deleted = schedulerService.deleteSchedule(req.params.name);
    if (!deleted) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    return res.status(204).send();
  });

  app.get('/api/analysis', async (req, res) => {
    const articles = await articleRepository.query({
      source: req.query.source,
      author: req.query.author,
      handle: req.query.handle,
      listId: req.query.listId,
      account: req.query.account,
      tag: req.query.tag,
      subreddit: req.query.subreddit,
      asset: req.query.asset,
      sentiment: req.query.sentiment,
    });
    res.json({ articles });
  });

  app.post('/api/analyze', async (req, res) => {
    try {
      const source = String(req.body?.source || '').trim();
      if (!source) {
        throw new Error('source is required');
      }
      const articles = await articleRepository.query({ source });
      const result = await sentimentService.requestAnalysis({
        source,
        articleIds: articles.map((article) => article.id || article.articleId),
        forceInline: !crawlService.queueService?.isEnabled(),
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/features', async (req, res) => {
    const features = await featureRepository.query({
      symbol: req.query.symbol,
      featureDate: req.query.date,
    });
    res.json({ features });
  });

  app.get('/api/mentions', async (req, res) => {
    const mentions = await mentionRepository.query({
      articleId: req.query.articleId,
      symbol: req.query.symbol,
      source: req.query.source,
    });
    res.json({ mentions });
  });

  return app;
}

module.exports = { createApp };