const path = require('path');
const { SourceConfigService } = require('./config/sourceConfigService');
const { CrawlService } = require('./core/crawlService');
const { JobService } = require('./services/jobService');
const { QueueService } = require('./services/queueService');
const { SchedulerService } = require('./services/schedulerService');
const { ArticleRepository } = require('./storage/articleRepository');
const { MentionRepository } = require('./storage/mentionRepository');
const { FeatureRepository } = require('./storage/featureRepository');
const { RawContentStore } = require('./storage/rawContentStore');
const { SentimentService } = require('./services/sentimentService');
const { ensureCrawlInsightSchema } = require('./services/schemaService');

function buildServices(overrides = {}) {
  const rootDir = overrides.rootDir || process.cwd();
  const configPath = overrides.configPath || path.join(rootDir, 'config', 'sources.yaml');
  const dataPath = overrides.dataPath || process.env.DATA_PATH || path.join(rootDir, 'data', 'articles.json');
  const rawContentPath = overrides.rawContentPath || process.env.RAW_CONTENT_PATH || path.join(rootDir, 'data', 'raw');
  const mentionDataPath = overrides.mentionDataPath || path.join(path.dirname(dataPath), 'mentions.json');
  const featureDataPath = overrides.featureDataPath || path.join(path.dirname(dataPath), 'daily-sentiment-features.json');

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
  const mentionRepository =
    overrides.mentionRepository ||
    (dbClient
      ? new MentionRepository({ db: dbClient })
      : new MentionRepository(mentionDataPath));
  const featureRepository =
    overrides.featureRepository ||
    (dbClient
      ? new FeatureRepository({ db: dbClient })
      : new FeatureRepository(featureDataPath));

  const rawContentStore = overrides.rawContentStore || new RawContentStore(rawContentPath);
  const queueService = overrides.queueService || new QueueService(dbClient ? process.env.DATABASE_URL : null);
  const jobService =
    overrides.jobService ||
    new JobService(dbClient);
  const sentimentService =
    overrides.sentimentService ||
    new SentimentService({
      articleRepository,
      mentionRepository,
      featureRepository,
      jobService,
      queueService,
    });
  const crawlService = overrides.crawlService || new CrawlService({
    sourceConfigService,
    articleRepository,
    sentimentService,
    jobService,
    rawContentStore,
    queueService,
  });
  const schedulerService = overrides.schedulerService || new SchedulerService(crawlService);

  async function start() {
    if (dbClient) {
      await ensureCrawlInsightSchema(dbClient);
    }

    if (!queueService.isEnabled()) {
      return;
    }

    await queueService.registerScrapeWorker(async (job) => {
      await crawlService.processQueuedJob(job);
    });
    await queueService.registerSentimentWorker(async (job) => {
      await sentimentService.processQueuedJob(job);
    });
  }

  async function stop() {
    schedulerService.stopAll();
    await queueService.stop();
  }

  return {
    sourceConfigService,
    articleRepository,
    mentionRepository,
    featureRepository,
    rawContentStore,
    jobService,
    sentimentService,
    crawlService,
    schedulerService,
    queueService,
    start,
    stop,
  };
}

module.exports = { buildServices };