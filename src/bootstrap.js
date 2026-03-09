const path = require('path');
const { SourceConfigService } = require('./config/sourceConfigService');
const { CrawlService } = require('./core/crawlService');
const { JobService } = require('./services/jobService');
const { SchedulerService } = require('./services/schedulerService');
const { ArticleRepository } = require('./storage/articleRepository');

function buildServices(overrides = {}) {
  const rootDir = overrides.rootDir || process.cwd();
  const configPath = overrides.configPath || path.join(rootDir, 'config', 'sources.yaml');
  const dataPath = overrides.dataPath || process.env.DATA_PATH || path.join(rootDir, 'data', 'articles.json');

  const sourceConfigService = overrides.sourceConfigService || new SourceConfigService(configPath);
  const articleRepository = overrides.articleRepository || new ArticleRepository(dataPath);
  const jobService = overrides.jobService || new JobService();
  const crawlService = overrides.crawlService || new CrawlService({ sourceConfigService, articleRepository, jobService });
  const schedulerService = overrides.schedulerService || new SchedulerService(crawlService);

  return {
    sourceConfigService,
    articleRepository,
    jobService,
    crawlService,
    schedulerService,
  };
}

module.exports = { buildServices };