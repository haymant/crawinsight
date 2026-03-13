const {
  pgTable,
  text,
  varchar,
  jsonb,
  timestamp,
  integer,
  boolean,
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
  sentiment: integer('sentiment'),
  assets: jsonb('assets'),
  published_at: timestamp('published_at', { mode: 'string' }),
  updated_at: timestamp('updated_at', { mode: 'string' }).defaultNow(),
});

const crawlinsight_article_mentions = pgTable('crawlinsight_article_mentions', {
  mention_id: varchar('mention_id', { length: 64 }).primaryKey(),
  article_id: varchar('article_id', { length: 64 }).references(() => crawlinsight_articles.article_id),
  asset_id: varchar('asset_id', { length: 30 }).notNull(),
  created_at: timestamp('created_at', { mode: 'string' }).defaultNow(),
});

module.exports = {
  crawlinsight_sources,
  crawlinsight_jobs,
  crawlinsight_articles,
  crawlinsight_article_mentions,
};

