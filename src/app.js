const express = require('express');

// swagger removed per user request; documentation is maintained separately if needed

function createApp({ sourceConfigService, crawlService, jobService, schedulerService, articleRepository }) {
  const app = express();
  app.use(express.json());


  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/sources', (req, res) => {
    res.json({ sources: sourceConfigService.listSources() });
  });

  app.post('/api/sources', (req, res) => {
    try {
      const { name, config } = req.body;
      const source = sourceConfigService.upsertSource(name, config);
      res.status(201).json({ name, source });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/api/sources/:name', (req, res) => {
    const deleted = sourceConfigService.deleteSource(req.params.name);
    if (!deleted) {
      return res.status(404).json({ error: 'Source not found' });
    }
    return res.status(204).send();
  });

  app.get('/api/scrapers', (req, res) => {
    res.json({ jobs: jobService.listJobs() });
  });

  app.post('/api/scrapers', async (req, res) => {
    try {
      const result = await crawlService.runSource(req.body.source);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/jobs', (req, res) => {
    res.json({ jobs: jobService.listJobs() });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobService.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json(job);
  });

  app.get('/api/schedulers', (req, res) => {
    res.json({ schedules: schedulerService.getSchedules() });
  });

  app.post('/api/schedulers', (req, res) => {
    try {
      const schedule = schedulerService.addSchedule({
        name: req.body.name,
        source: req.body.source,
        expression: req.body.expression,
      });
      res.status(201).json(schedule);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/analysis', (req, res) => {
    const articles = articleRepository.query({
      source: req.query.source,
      asset: req.query.asset,
      sentiment: req.query.sentiment,
    });
    res.json({ articles });
  });

  return app;
}

module.exports = { createApp };