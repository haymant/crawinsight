import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  uuid,
  jsonb,
  integer,
  bigint,
  doublePrecision,
  date,
  boolean,
  primaryKey,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";

// legacy placeholder table kept for compatibility if we ever need it
// (not part of the current DDL).
// export const users = pgTable("users", {
//   id: serial("id").primaryKey(),
//   email: varchar("email", { length: 255 }).notNull().unique(),
//   created_at: timestamp("created_at").defaultNow().notNull(),
// });

// datasources, dashboards, tiles, queries, chats, etc. mirrored from SQL scripts
export const datasources = pgTable("datasources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type").notNull().default("duckdb"),
  connection_string_encrypted: text("connection_string_encrypted").notNull(),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const dashboards = pgTable("dashboards", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  sort_order: integer("sort_order").default(0),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const tiles = pgTable("tiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  dashboard_id: uuid("dashboard_id").notNull(),
  name: text("name").notNull().default("Untitled Tile"),
  layout_x: integer("layout_x").default(0),
  layout_y: integer("layout_y").default(0),
  layout_w: integer("layout_w").default(6),
  layout_h: integer("layout_h").default(4),
  datasource_id: uuid("datasource_id"),
  query_sql: text("query_sql").default(''),
  view_config: jsonb("view_config").default('{"viewType": "table"}'),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const queries = pgTable("queries", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  query_sql: text("query_sql").notNull(),
  datasource_id: uuid("datasource_id"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

// visualisation tables
export const daily_asset_sentiment = pgTable("daily_asset_sentiment", {
  asset_symbol: varchar("asset_symbol", { length: 20 }).notNull(),
  day_date: date("day_date").notNull(),
  avg_sentiment: doublePrecision("avg_sentiment").notNull(),
  total_mentions: integer("total_mentions").notNull(),
  positive_mentions: integer("positive_mentions").default(0),
  negative_mentions: integer("negative_mentions").default(0),
  neutral_mentions: integer("neutral_mentions").default(0),
  article_count: integer("article_count").default(1),
});

export const dailySentimentFeatures = pgTable("daily_sentiment_features", {
  id: serial("id").primaryKey(),
  feature_date: timestamp("feature_date", { withTimezone: true }).notNull(),
  symbol: text("symbol").notNull(),
  article_count: integer("article_count"),
  vader_mean: doublePrecision("vader_mean"),
  llm_mean: doublePrecision("llm_mean"),
  mention_density: doublePrecision("mention_density"),
  positive_ratio: doublePrecision("positive_ratio"),
  earnings_keyword_score: doublePrecision("earnings_keyword_score"),
  guidance_keyword_score: doublePrecision("guidance_keyword_score"),
  sentiment_momentum_1d: doublePrecision("sentiment_momentum_1d"),
  sentiment_volatility_7d: doublePrecision("sentiment_volatility_7d"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const realtimeFeatures = pgTable("realtime_features", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  as_of: timestamp("as_of", { withTimezone: true }).defaultNow().notNull(),
  vader_mean: doublePrecision("vader_mean"),
  mention_density: doublePrecision("mention_density"),
  sentiment_momentum_1d: doublePrecision("sentiment_momentum_1d"),
  z_vader_mean: doublePrecision("z_vader_mean"),
  z_mention_density: doublePrecision("z_mention_density"),
  z_sentiment_momentum_1d: doublePrecision("z_sentiment_momentum_1d"),
  decay_half_life_hours: integer("decay_half_life_hours").default(4).notNull(),
});

// chat-related tables defined in the SQL dump
export const users = pgTable("User", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 64 }).notNull(),
  password: varchar("password", { length: 64 }),
});

export const chat = pgTable("Chat", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("createdAt").notNull(),
  title: text("title").notNull(),
  userId: uuid("userId").notNull(),
  visibility: varchar("visibility", { length: 10 }).notNull().default("private"),
});

export const message_v2 = pgTable("Message_v2", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatId: uuid("chatId").notNull(),
  role: varchar("role", { length: 20 }).notNull(),
  parts: jsonb("parts").notNull(),
  attachments: jsonb("attachments").notNull(),
  createdAt: timestamp("createdAt").notNull(),
});

export const vote_v2 = pgTable(
  "Vote_v2",
  {
    chatId: uuid("chatId").notNull(),
    messageId: uuid("messageId").notNull(),
    isUpvoted: boolean("isUpvoted").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.messageId] }),
  })
);

export const document = pgTable("Document", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("createdAt").notNull(),
  title: text("title").notNull(),
  content: text("content"),
  kind: varchar("kind", { length: 20 }).notNull().default("text"),
  userId: uuid("userId").notNull(),
});

export const suggestion = pgTable("Suggestion", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("documentId").notNull(),
  documentCreatedAt: timestamp("documentCreatedAt").notNull(),
  originalText: text("originalText").notNull(),
  suggestedText: text("suggestedText").notNull(),
  description: text("description"),
  isResolved: boolean("isResolved").notNull().default(false),
  userId: uuid("userId").notNull(),
  createdAt: timestamp("createdAt").notNull(),
});


// Legacy schemas were used for the original channel/job UI but are now replaced by the CrawlInsight service.
// The following table definitions are retained for historical reference only.

export const articles = pgTable("articles", {
  // article_id is manually backed by a sequence; migration 0001_add_article_seq
  // sets up the default. bigserial helper is not available in drizzle-kit.
  article_id: bigint("article_id", { mode: "number" }).primaryKey(),
  channel_id: varchar("channel_id", { length: 64 }),
  url: varchar("url", { length: 2048 }).notNull(),
  content_hash: varchar("content_hash", { length: 64 }).notNull(),
  analysis: text("analysis"),
  article: varchar("article", { length: 2048 }).notNull(),
  tags: jsonb("tags"),
  // using jsonb for embedding vectors if no vector type available, or we can use custom type
  article_vector: jsonb("article_vector"),
  authors: jsonb("authors"),
  author_weight: jsonb("author_weight"),
  published_at: timestamp("published_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
}, (table) => ({
  uniqueUrlHash: unique("articles_url_hash_unique").on(table.url, table.content_hash),
}));

export const storages = pgTable("storages", {
  storage_id: varchar("storage_id", { length: 64 }).primaryKey(),
  type: text("type").notNull(),
  config: jsonb("config").notNull(),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const sentimentAnalysis = pgTable("sentiment_analysis", {
  article_id: bigint("article_id", { mode: "number" }).notNull(),
  asset_id: varchar("asset_id", { length: 30 }).notNull(),
  sentiment: integer("sentiment"),
  published_at: date("published_at").notNull(),
  updated_at: date("updated_at"),
}, (table) => ({
  pk: primaryKey({ columns: [table.asset_id, table.article_id, table.published_at] }),
}));

export const crawlinsight_sources = pgTable("crawlinsight_sources", {
  name: text("name").primaryKey(),
  display_name: text("display_name"),
  type: text("type").notNull(),
  concurrency: integer("concurrency").default(2),
  urls: jsonb("urls").notNull(),
  filters: jsonb("filters"),
  params: jsonb("params"),
  options: jsonb("options"),
  disabled: boolean("disabled").default(false),
  storage_id: varchar("storage_id", { length: 64 }),
});

// new tables for persisted crawlinsight data
export const crawlinsight_jobs = pgTable("crawlinsight_jobs", {
  job_id: varchar("job_id", { length: 36 }).primaryKey(),
  source_name: text("source_name").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload"),
  status: text("status").notNull(),
  result: jsonb("result"),
  error: text("error"),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string" }).defaultNow(),
  started_at: timestamp("started_at", { mode: "string" }),
  finished_at: timestamp("finished_at", { mode: "string" }),
  queue_id: text("queue_id"),
});

export const crawlinsight_articles = pgTable("crawlinsight_articles", {
  article_id: varchar("article_id", { length: 64 }).primaryKey(),
  source: text("source").notNull(),
  title: text("title"),
  link: text("link"),
  author: text("author"),
  handle: text("handle"),
  list_id: text("list_id"),
  subreddit: text("subreddit"),
  content: text("content"),
  summary: text("summary"),
  full_content_path: text("full_content_path"),
  sentiment: jsonb("sentiment"),
  sentiment_type: text("sentiment_type"),
  assets: jsonb("assets"),
  linked_article_ids: jsonb("linked_article_ids"),
  crawl_depth: integer("crawl_depth").default(1),
  ingested_at: timestamp("ingested_at", { mode: "string" }),
  published_at: timestamp("published_at", { mode: "string" }),
  updated_at: timestamp("updated_at", { mode: "string" }).defaultNow(),
  metadata: jsonb("metadata"),
});

export const crawlinsight_article_mentions = pgTable("crawlinsight_article_mentions", {
  mention_id: varchar("mention_id", { length: 64 }).primaryKey(),
  article_id: varchar("article_id", { length: 64 }).references(() => crawlinsight_articles.article_id),
  source_name: text("source_name"),
  asset_id: varchar("asset_id", { length: 30 }).notNull(),
  context_snippet: text("context_snippet"),
  vader_compound: doublePrecision("vader_compound"),
  llm_score: doublePrecision("llm_score"),
  final_score: doublePrecision("final_score"),
  sentiment_type: text("sentiment_type"),
  mention_offset: integer("mention_offset"),
  published_at: timestamp("published_at", { mode: "string" }),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
});

// ==== finance/accounting schema derived from 001_create_schema.sql ====

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: text("account_id").notNull().unique(),
  account_name: text("account_name").notNull(),
  platform: text("platform").notNull(),
  base_currency: text("base_currency").notNull().default("USD"),
  account_type: text("account_type").default("Individual"),
  account_capabilities: text("account_capabilities"),
  status: text("status").notNull().default("active"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const instruments = pgTable("instruments", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: text("symbol").notNull(),
  con_id: text("con_id"),
  description: text("description"),
  asset_category: text("asset_category").notNull(),
  listing_exchange: text("listing_exchange"),
  multiplier: doublePrecision("multiplier").default(1),
  currency: text("currency").notNull().default("USD"),
  security_id: text("security_id"),
  security_id_type: text("security_id_type"),
  cusip: text("cusip"),
  isin: text("isin"),
  figi: text("figi"),
  issuer_country_code: text("issuer_country_code"),
  underlying_symbol: text("underlying_symbol"),
  underlying_con_id: text("underlying_con_id"),
  underlying_category: text("underlying_category"),
  strike: doublePrecision("strike"),
  expiry: date("expiry"),
  put_call: text("put_call"),
  maturity_date: date("maturity_date"),
  issue_date: date("issue_date"),
  underlying_listing_exchange: text("underlying_listing_exchange"),
  is_traded: boolean("is_traded").default(false),
  is_active: boolean("is_active").default(true),
});

export const portfolios = pgTable("portfolios", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  account_id: uuid("account_id"),
  base_currency: text("base_currency").notNull().default("USD"),
  strategy: text("strategy"),
  status: text("status").notNull().default("active"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const trades = pgTable("trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  instrument_id: uuid("instrument_id"),
  portfolio_id: uuid("portfolio_id"),
  symbol: text("symbol").notNull(),
  description: text("description"),
  asset_category: text("asset_category").notNull(),
  trade_date: date("trade_date").notNull(),
  settle_date: date("settle_date"),
  trade_time: text("trade_time"),
  exchange: text("exchange"),
  quantity: doublePrecision("quantity").notNull(),
  trade_price: doublePrecision("trade_price").notNull(),
  currency: text("currency").notNull().default("USD"),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  proceeds: doublePrecision("proceeds"),
  comm_fee: doublePrecision("comm_fee").default(0),
  other_fees: doublePrecision("other_fees").default(0),
  basis: doublePrecision("basis"),
  realized_pnl: doublePrecision("realized_pnl"),
  mtm_pnl: doublePrecision("mtm_pnl"),
  trade_id: text("trade_id"),
  order_id: text("order_id"),
  exec_id: text("exec_id"),
  buy_sell: text("buy_sell").notNull(),
  order_type: text("order_type"),
  open_close: text("open_close"),
  notes: text("notes"),
  is_reconciled: boolean("is_reconciled").default(false),
  source: text("source").default("manual"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const cashTransactions = pgTable("cash_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  transaction_date: date("transaction_date").notNull(),
  settle_date: date("settle_date"),
  currency: text("currency").notNull(),
  amount: doublePrecision("amount").notNull(),
  transaction_type: text("transaction_type").notNull(),
  description: text("description"),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  reference_id: text("reference_id"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const dividends = pgTable("dividends", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  instrument_id: uuid("instrument_id"),
  symbol: text("symbol").notNull(),
  description: text("description"),
  currency: text("currency").notNull(),
  ex_date: date("ex_date"),
  pay_date: date("pay_date").notNull(),
  quantity: doublePrecision("quantity"),
  tax: doublePrecision("tax").default(0),
  fee: doublePrecision("fee").default(0),
  gross_rate: doublePrecision("gross_rate"),
  gross_amount: doublePrecision("gross_amount").notNull(),
  net_amount: doublePrecision("net_amount").notNull(),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  action_id: text("action_id"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const withholdingTax = pgTable("withholding_tax", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  instrument_id: uuid("instrument_id"),
  symbol: text("symbol").notNull(),
  description: text("description"),
  currency: text("currency").notNull(),
  tax_date: date("tax_date").notNull(),
  amount: doublePrecision("amount").notNull(),
  tax_type: text("tax_type"),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  action_id: text("action_id"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const interest = pgTable("interest", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  instrument_id: uuid("instrument_id"),
  symbol: text("symbol"),
  description: text("description"),
  currency: text("currency").notNull(),
  interest_date: date("interest_date").notNull(),
  amount: doublePrecision("amount").notNull(),
  interest_type: text("interest_type"),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  action_id: text("action_id"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const interestAccruals = pgTable("interest_accruals", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  instrument_id: uuid("instrument_id"),
  symbol: text("symbol").notNull(),
  description: text("description"),
  currency: text("currency").notNull(),
  accrual_date: date("accrual_date").notNull(),
  starting_accrual_balance: doublePrecision("starting_accrual_balance").default(0),
  interest_accrued: doublePrecision("interest_accrued").notNull(),
  ending_accrual_balance: doublePrecision("ending_accrual_balance").notNull(),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const dividendAccruals = pgTable("dividend_accruals", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  instrument_id: uuid("instrument_id"),
  symbol: text("symbol").notNull(),
  description: text("description"),
  currency: text("currency").notNull(),
  ex_date: date("ex_date").notNull(),
  pay_date: date("pay_date"),
  quantity: doublePrecision("quantity"),
  tax: doublePrecision("tax").default(0),
  fee: doublePrecision("fee").default(0),
  gross_rate: doublePrecision("gross_rate"),
  gross_amount: doublePrecision("gross_amount").notNull(),
  net_amount: doublePrecision("net_amount").notNull(),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const transactionFees = pgTable("transaction_fees", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  instrument_id: uuid("instrument_id"),
  trade_id: uuid("trade_id"),
  symbol: text("symbol"),
  description: text("description"),
  currency: text("currency").notNull(),
  fee_date: date("fee_date").notNull(),
  amount: doublePrecision("amount").notNull(),
  fee_type: text("fee_type"),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const forexBalances = pgTable("forex_balances", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  as_of_date: date("as_of_date").notNull(),
  currency: text("currency").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  cost_basis: doublePrecision("cost_basis"),
  close_price: doublePrecision("close_price"),
  value: doublePrecision("value"),
  unrealized_pnl: doublePrecision("unrealized_pnl"),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const openPositions = pgTable("open_positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  instrument_id: uuid("instrument_id"),
  portfolio_id: uuid("portfolio_id"),
  as_of_date: date("as_of_date").notNull(),
  symbol: text("symbol").notNull(),
  description: text("description"),
  asset_category: text("asset_category").notNull(),
  currency: text("currency").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  cost_basis_price: doublePrecision("cost_basis_price"),
  cost_basis_money: doublePrecision("cost_basis_money"),
  close_price: doublePrecision("close_price"),
  market_value: doublePrecision("market_value"),
  unrealized_pnl: doublePrecision("unrealized_pnl"),
  unrealized_pnl_pct: doublePrecision("unrealized_pnl_pct"),
  fx_rate_to_base: doublePrecision("fx_rate_to_base").default(1),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const navSnapshots = pgTable("nav_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  as_of_date: date("as_of_date").notNull(),
  cash: doublePrecision("cash").default(0),
  stock: doublePrecision("stock").default(0),
  options: doublePrecision("options").default(0),
  bonds: doublePrecision("bonds").default(0),
  funds: doublePrecision("funds").default(0),
  futures: doublePrecision("futures").default(0),
  accrued_interest: doublePrecision("accrued_interest").default(0),
  dividend_accruals: doublePrecision("dividend_accruals").default(0),
  total_nav: doublePrecision("total_nav").notNull(),
  currency: text("currency").notNull().default('USD'),
});

export const performanceSummary = pgTable("performance_summary", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  period_start: date("period_start").notNull(),
  period_end: date("period_end").notNull(),
  starting_nav: doublePrecision("starting_nav"),
  ending_nav: doublePrecision("ending_nav"),
  deposits: doublePrecision("deposits").default(0),
  withdrawals: doublePrecision("withdrawals").default(0),
  dividends: doublePrecision("dividends").default(0),
  interest: doublePrecision("interest").default(0),
  realized_pnl: doublePrecision("realized_pnl").default(0),
  unrealized_pnl: doublePrecision("unrealized_pnl").default(0),
  commissions: doublePrecision("commissions").default(0),
  fees: doublePrecision("fees").default(0),
  net_pnl: doublePrecision("net_pnl"),
  time_weighted_return: doublePrecision("time_weighted_return"),
  currency: text("currency").notNull().default('USD'),
});

export const activityImports = pgTable("activity_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id"),
  file_name: text("file_name").notNull(),
  file_hash: text("file_hash"),
  platform: text("platform").notNull(),
  period_start: date("period_start"),
  period_end: date("period_end"),
  import_status: text("import_status").notNull().default('pending'),
  records_imported: integer("records_imported").default(0),
  records_failed: integer("records_failed").default(0),
  error_log: jsonb("error_log"),
  imported_at: timestamp("imported_at").notNull().defaultNow(),
});

export const reconciliationLog = pgTable("reconciliation_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  import_id: uuid("import_id"),
  record_type: text("record_type").notNull(),
  status: text("status").notNull(),
  system_record: jsonb("system_record"),
  report_record: jsonb("report_record"),
  differences: jsonb("differences"),
  resolution: text("resolution"),
  resolved_at: timestamp("resolved_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});
