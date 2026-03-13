const {
  pgTable,
  text,
  varchar,
  jsonb,
  timestamp,
  integer,
  boolean,
  serial,
  doublePrecision,
} = require('drizzle-orm/pg-core');

// Schema definitions for CrawlInsight persistence.
// These are used at runtime by the CrawlInsight service.

const crawlinsight_sources = pgTable('crawlinsight_sources', {
  name: text('name').primaryKey(),
  display_name: text('display_name'),
  type: text('type').notNull(),
  concurrency: integer('concurrency').default(2),
  urls: jsonb('urls').notNull(),
  filters: jsonb('filters'),
  params: jsonb('params'),
  options: jsonb('options'),
  disabled: boolean('disabled').default(false),
  storage_id: varchar('storage_id', { length: 64 }),
});

const crawlinsight_jobs = pgTable('crawlinsight_jobs', {
  job_id: varchar('job_id', { length: 36 }).primaryKey(),
  source_name: text('source_name').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload'),
  status: text('status').notNull(),
  result: jsonb('result'),
  error: text('error'),
  created_at: timestamp('created_at', { mode: 'string' }).defaultNow(),
  updated_at: timestamp('updated_at', { mode: 'string' }).defaultNow(),
  started_at: timestamp('started_at', { mode: 'string' }),
  finished_at: timestamp('finished_at', { mode: 'string' }),
  queue_id: text('queue_id'),
});

const crawlinsight_articles = pgTable('crawlinsight_articles', {
  article_id: varchar('article_id', { length: 64 }).primaryKey(),
  source: text('source').notNull(),
  title: text('title'),
  link: text('link'),
  author: text('author'),
  handle: text('handle'),
  list_id: text('list_id'),
  subreddit: text('subreddit'),
  content: text('content'),
  summary: text('summary'),
  full_content_path: text('full_content_path'),
  sentiment: jsonb('sentiment'),
  sentiment_type: text('sentiment_type'),
  assets: jsonb('assets'),
  linked_article_ids: jsonb('linked_article_ids'),
  crawl_depth: integer('crawl_depth').default(1),
  ingested_at: timestamp('ingested_at', { mode: 'string' }),
  published_at: timestamp('published_at', { mode: 'string' }),
  updated_at: timestamp('updated_at', { mode: 'string' }).defaultNow(),
  metadata: jsonb('metadata'),
});

const crawlinsight_article_mentions = pgTable('crawlinsight_article_mentions', {
  mention_id: varchar('mention_id', { length: 64 }).primaryKey(),
  article_id: varchar('article_id', { length: 64 }).references(() => crawlinsight_articles.article_id),
  source_name: text('source_name'),
  asset_id: varchar('asset_id', { length: 30 }).notNull(),
  context_snippet: text('context_snippet'),
  vader_compound: doublePrecision('vader_compound'),
  llm_score: doublePrecision('llm_score'),
  final_score: doublePrecision('final_score'),
  sentiment_type: text('sentiment_type'),
  mention_offset: integer('mention_offset'),
  published_at: timestamp('published_at', { mode: 'string' }),
  created_at: timestamp('created_at', { mode: 'string' }).defaultNow(),
});

const daily_sentiment_features = pgTable('daily_sentiment_features', {
  id: serial('id').primaryKey(),
  feature_date: timestamp('feature_date', { mode: 'string' }),
  symbol: text('symbol').notNull(),
  article_count: integer('article_count'),
  vader_mean: doublePrecision('vader_mean'),
  llm_mean: doublePrecision('llm_mean'),
  mention_density: doublePrecision('mention_density'),
  positive_ratio: doublePrecision('positive_ratio'),
  earnings_keyword_score: doublePrecision('earnings_keyword_score'),
  guidance_keyword_score: doublePrecision('guidance_keyword_score'),
  sentiment_momentum_1d: doublePrecision('sentiment_momentum_1d'),
  sentiment_volatility_7d: doublePrecision('sentiment_volatility_7d'),
  created_at: timestamp('created_at', { mode: 'string' }).defaultNow(),
});

module.exports = {
  crawlinsight_sources,
  crawlinsight_jobs,
  crawlinsight_articles,
  crawlinsight_article_mentions,
  daily_sentiment_features,
};

