const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildServices } = require('../src/bootstrap');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crawlinsight-google-live-'));
}

function buildSourceYaml(strategy) {
  const urls = [
    'https://news.google.com/rss/search?q=site:reuters.com%20markets&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=site:reuters.com%20business&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=site:reuters.com%20(oil%20OR%20fed%20OR%20earnings)&hl=en-US&gl=US&ceid=US:en',
  ];

  return [
    'sources:',
    '  google-benchmark:',
    '    type: rss',
    '    urls:',
    ...urls.map((url) => `      - ${url}`),
    '    filters:',
    '      keywords: [earnings, fed, rates, oil, commodities, market, stocks]',
    '    options:',
    '      maxCrawlDepth: 2',
    '      maxItemsPerFeed: 6',
    `      linkedArticleBrowserFallback: ${strategy.browserMode}`,
    '      validateDepth2Content: true',
  ].join('\n');
}

function buildMetrics(articles) {
  const parents = articles.filter((article) => article.crawlDepth === 1);
  const attempted = parents.filter((article) => article.metadata?.depth2FetchedAt).length;
  const succeeded = parents.filter((article) => article.metadata?.depth2Success === true).length;
  const failures = parents
    .filter((article) => article.metadata?.depth2Success === false)
    .map((article) => ({
      title: article.title,
      link: article.link,
      reason: article.metadata?.depth2Reason,
      excerpt: article.metadata?.depth2ValidationExcerpt,
      resolved: article.metadata?.depth2ResolvedLink,
    }));
  const rate = attempted > 0 ? succeeded / attempted : 0;

  return {
    attempted,
    succeeded,
    rate,
    failures,
  };
}

function resolveStrategies() {
  const knownStrategies = {
    'http-plus-browser-fallback': { name: 'http-plus-browser-fallback', browserMode: 'true' },
    'browser-first': { name: 'browser-first', browserMode: 'always' },
  };

  const requestedStrategy = String(process.env.GOOGLE_DEPTH2_STRATEGY || '').trim().toLowerCase();
  if (requestedStrategy) {
    const selected = knownStrategies[requestedStrategy];
    if (!selected) {
      throw new Error(`Unknown GOOGLE_DEPTH2_STRATEGY: ${requestedStrategy}`);
    }
    return [selected];
  }

  const isHeadfulDebug = process.env.RSS_HEADLESS === 'false';
  if (isHeadfulDebug) {
    return [knownStrategies['browser-first']];
  }

  return [
    knownStrategies['http-plus-browser-fallback'],
    knownStrategies['browser-first'],
  ];
}

async function runStrategy(strategy) {
  const tempDir = makeTempDir();
  const configPath = path.join(tempDir, 'sources.yaml');
  const dataPath = path.join(tempDir, 'articles.json');
  fs.writeFileSync(configPath, buildSourceYaml(strategy));

  const services = buildServices({
    rootDir: path.join(__dirname, '..'),
    configPath,
    dataPath,
    queueService: { isEnabled: () => false, publishScrapeJob: async () => null, registerScrapeWorker: async () => {} },
    jobService: { createJob: () => ({ id: 'live-benchmark' }), updateJob: async () => {}, listJobs: async () => [], getJob: async () => null },
  });

  try {
    const result = await services.crawlService.runSource('google-benchmark', { forceInline: true, maxCrawlDepth: 2 });
    const articles = await services.articleRepository.query({ source: 'google-benchmark' });
    const metrics = buildMetrics(articles);

    return {
      strategy: strategy.name,
      browserMode: strategy.browserMode,
      result,
      articles,
      metrics,
    };
  } finally {
    await services.stop?.().catch(() => undefined);
  }
}

async function main() {
  const targetRate = Number(process.env.GOOGLE_DEPTH2_TARGET_RATE || 0.7);
  const strategies = resolveStrategies();

  let bestRun = null;
  for (const strategy of strategies) {
    const run = await runStrategy(strategy);
    if (!bestRun || run.metrics.rate > bestRun.metrics.rate) {
      bestRun = run;
    }

    console.log(JSON.stringify({
      strategy: run.strategy,
      browserMode: run.browserMode,
      attempted: run.metrics.attempted,
      succeeded: run.metrics.succeeded,
      successRate: Number(run.metrics.rate.toFixed(4)),
      failures: run.metrics.failures.slice(0, 5),
    }, null, 2));

    if (run.metrics.rate >= targetRate) {
      console.log(`Benchmark target met with strategy=${run.strategy} rate=${(run.metrics.rate * 100).toFixed(1)}%`);
      return;
    }
  }

  if (!bestRun) {
    process.exitCode = 1;
    throw new Error('No benchmark run completed');
  }

  process.exitCode = 1;
  throw new Error(`Best live depth-2 success rate was ${(bestRun.metrics.rate * 100).toFixed(1)}%, below target ${(targetRate * 100).toFixed(1)}%`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});