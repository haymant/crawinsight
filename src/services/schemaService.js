function getRawQueryClient(db) {
  if (!db) return null;
  if (typeof db.$client?.query === 'function') return db.$client;
  if (typeof db.session?.client?.query === 'function') return db.session.client;
  return null;
}

async function ensureCrawlInsightSchema(db) {
  const rawClient = getRawQueryClient(db);
  if (!rawClient) {
    return;
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS crawlinsight_articles (
      article_id varchar(64) PRIMARY KEY,
      source text NOT NULL,
      title text,
      link text,
      author text,
      handle text,
      list_id text,
      subreddit text,
      content text,
      summary text,
      full_content_path text,
      sentiment jsonb,
      sentiment_type text,
      assets jsonb,
      linked_article_ids jsonb,
      crawl_depth integer DEFAULT 1,
      ingested_at timestamp,
      published_at timestamp,
      updated_at timestamp DEFAULT now(),
      metadata jsonb
    )`,
    `ALTER TABLE crawlinsight_articles ADD COLUMN IF NOT EXISTS summary text`,
    `ALTER TABLE crawlinsight_articles ADD COLUMN IF NOT EXISTS full_content_path text`,
    `ALTER TABLE crawlinsight_articles ADD COLUMN IF NOT EXISTS sentiment_type text`,
    `ALTER TABLE crawlinsight_articles ADD COLUMN IF NOT EXISTS linked_article_ids jsonb`,
    `ALTER TABLE crawlinsight_articles ADD COLUMN IF NOT EXISTS crawl_depth integer DEFAULT 1`,
    `ALTER TABLE crawlinsight_articles ADD COLUMN IF NOT EXISTS ingested_at timestamp`,
    `ALTER TABLE crawlinsight_articles ADD COLUMN IF NOT EXISTS metadata jsonb`,
    `DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'crawlinsight_articles'
            AND column_name = 'sentiment'
            AND data_type <> 'jsonb'
        ) THEN
          ALTER TABLE crawlinsight_articles
          ALTER COLUMN sentiment TYPE jsonb
          USING CASE WHEN sentiment IS NULL THEN NULL ELSE jsonb_build_object('legacy', sentiment) END;
        END IF;
      END $$`,
    `CREATE TABLE IF NOT EXISTS crawlinsight_article_mentions (
      mention_id varchar(64) PRIMARY KEY,
      article_id varchar(64) REFERENCES crawlinsight_articles(article_id) ON DELETE CASCADE,
      source_name text,
      asset_id varchar(30) NOT NULL,
      context_snippet text,
      vader_compound double precision,
      llm_score double precision,
      final_score double precision,
      sentiment_type text,
      mention_offset integer,
      published_at timestamp,
      created_at timestamp DEFAULT now()
    )`,
    `ALTER TABLE crawlinsight_article_mentions ADD COLUMN IF NOT EXISTS source_name text`,
    `ALTER TABLE crawlinsight_article_mentions ADD COLUMN IF NOT EXISTS context_snippet text`,
    `ALTER TABLE crawlinsight_article_mentions ADD COLUMN IF NOT EXISTS vader_compound double precision`,
    `ALTER TABLE crawlinsight_article_mentions ADD COLUMN IF NOT EXISTS llm_score double precision`,
    `ALTER TABLE crawlinsight_article_mentions ADD COLUMN IF NOT EXISTS final_score double precision`,
    `ALTER TABLE crawlinsight_article_mentions ADD COLUMN IF NOT EXISTS sentiment_type text`,
    `ALTER TABLE crawlinsight_article_mentions ADD COLUMN IF NOT EXISTS mention_offset integer`,
    `ALTER TABLE crawlinsight_article_mentions ADD COLUMN IF NOT EXISTS published_at timestamp`,
    `CREATE TABLE IF NOT EXISTS daily_sentiment_features (
      id serial PRIMARY KEY,
      feature_date timestamp NOT NULL,
      symbol text NOT NULL,
      article_count integer,
      vader_mean double precision,
      llm_mean double precision,
      mention_density double precision,
      positive_ratio double precision,
      earnings_keyword_score double precision,
      guidance_keyword_score double precision,
      sentiment_momentum_1d double precision,
      sentiment_volatility_7d double precision,
      created_at timestamp DEFAULT now()
    )`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS feature_date timestamp`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS symbol text`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS article_count integer`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS vader_mean double precision`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS llm_mean double precision`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS mention_density double precision`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS positive_ratio double precision`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS earnings_keyword_score double precision`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS guidance_keyword_score double precision`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS sentiment_momentum_1d double precision`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS sentiment_volatility_7d double precision`,
    `ALTER TABLE daily_sentiment_features ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now()`,
    `CREATE UNIQUE INDEX IF NOT EXISTS daily_sentiment_features_symbol_date_idx ON daily_sentiment_features(feature_date, symbol)`,
  ];

  for (const statement of statements) {
    await rawClient.query(statement);
  }
}

module.exports = { ensureCrawlInsightSchema };