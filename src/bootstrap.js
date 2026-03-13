const path = require('path');
const { SourceConfigService } = require('./config/sourceConfigService');
const { CrawlService } = require('./core/crawlService');
const { JobService } = require('./services/jobService');
const { QueueService } = require('./services/queueService');
const { SchedulerService } = require('./services/schedulerService');
const { ArticleRepository } = require('./storage/articleRepository');
const { RawContentStore } = require('./storage/rawContentStore');

function buildServices(overrides = {}) {
  const rootDir = overrides.rootDir || process.cwd();
  const configPath = overrides.configPath || path.join(rootDir, 'config', 'sources.yaml');
  const dataPath = overrides.dataPath || process.env.DATA_PATH || path.join(rootDir, 'data', 'articles.json');
  const rawContentPath = overrides.rawContentPath || process.env.RAW_CONTENT_PATH || path.join(rootDir, 'data', 'raw');

  // When a custom config or data path is passed in, prefer local/file-backed
  // services unless the caller explicitly provides a DB client.
  const dbClient = Object.prototype.hasOwnProperty.call(overrides, 'dbClient')
    ? overrides.dbClient
    : (overrides.configPath || overrides.dataPath ? null : require('./db').db);

  const sourceConfigService =
    overrides.sourceConfigService ||
    new SourceConfigService({ db: dbClient, configPath });

  const articleRepository =
    overrides.articleRepository ||
    (dbClient
      ? new ArticleRepository({ db: dbClient })
      : new ArticleRepository(dataPath));

  const rawContentStore = overrides.rawContentStore || new RawContentStore(rawContentPath);
  const queueService = overrides.queueService || new QueueService(dbClient ? process.env.DATABASE_URL : null);
  const jobService =
    overrides.jobService ||
    new JobService(dbClient);
  const crawlService = overrides.crawlService || new CrawlService({
    sourceConfigService,
    articleRepository,
    jobService,
    rawContentStore,
    queueService,
  });
  const schedulerService = overrides.schedulerService || new SchedulerService(crawlService);

  async function start() {
    if (!queueService.isEnabled()) {
      return;
    }

    await queueService.registerScrapeWorker(async (job) => {
      await crawlService.processQueuedJob(job);
    });
  }

  async function stop() {
    schedulerService.stopAll();
    await queueService.stop();
  }

  return {
    sourceConfigService,
    articleRepository,
    rawContentStore,
    jobService,
    crawlService,
    schedulerService,
    queueService,
    start,
    stop,
  };
}

module.exports = { buildServices };