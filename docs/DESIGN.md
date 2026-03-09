### Design of Scraping and Sentiment Analysis Service for Financial Data

This design outlines a scalable, modular service called **FinScrapeSentiment** for scraping financial RSS feeds, news articles, and earnings transcripts from sources like a Google News financial feed (focusing on Reuters links), Bloomberg, New York Times (NYT), Seeking Alpha, and others. It performs VADER-based sentiment analysis on extracted content, focusing on financial assets (e.g., stock tickers, companies). The service is self-hosted/on-premise (adaptable to cloud), inspired by Apify but built on open-source Crawlee for cost-efficiency and control.

The design emphasizes:
- **Modularity**: Plug-and-play modules for data sources, driven by declarative JSON/YAML configs.
- **API-Driven Management**: REST API for configuration and monitoring.
- **Testing and Pipeline**: Built-in support for automated testing and CI/CD.
- **Extensibility**: Easy addition of new sources (e.g., Reddit, X) via metadata.

#### 0. Scope Refinement for MVP
The initial MVP should stay opinionated and implementable with minimal operational dependencies while preserving the extension points needed for broader coverage later.

- **Primary Goal**: Scrape finance-relevant RSS and transcript-style feeds, score sentiment with VADER, extract likely asset references, and expose the results through a local API.
- **Initial Sources**: Google News financial feed (Reuters links), Bloomberg, New York Times, Seeking Alpha, with config-driven support for WSJ, FT, CNBC, and Yahoo Finance.
- **Deployment Target**: Local or VPS deployment first; Apify remains a useful reference architecture rather than a runtime dependency.
- **Persistence Choice for MVP**: Use a lightweight local store abstraction, with SQLite preferred for simple deployments and testability.
- **Out of Scope for MVP**: Full browser automation for paywalled sources, authenticated X scraping, advanced NER, and distributed queue orchestration.

#### 0.1 Cost and Platform Positioning
Apify is useful as a benchmark for ergonomics, but the intended implementation should remain self-hosted.

- **Apify Cost Baseline**:
  - Free tier is acceptable for prototyping low-frequency RSS scraping.
  - Starter-tier economics become relevant once schedules become hourly and sources expand beyond plain RSS.
  - Browser automation and residential proxy usage materially increase operating cost.
- **On-Premise Cost Baseline**:
  - A single VPS or small instance is sufficient for RSS-heavy workloads.
  - Operational cost is mostly compute, storage, and optional proxy/network egress.
  - Self-hosting trades platform convenience for lower recurring cost and higher data control.
- **Decision**: Build against open-source Crawlee-compatible concepts, but ship a local service with its own API, scheduling, and persistence.

#### 0.2 Local Deployment Model
Because `apify push` is cloud-specific, the local deployment workflow should be explicit.

- **Runtime**: Node.js service with CLI and HTTP API entry points.
- **Packaging**: Docker image for reproducible local/VPS deployment.
- **Deployment Flow**: Pull source → install dependencies → run tests → build container → restart service.
- **Apify-Like Local Operations**: Replace Actor input with YAML config, replace Apify dataset with local persistence/export, and replace Apify scheduling with cron-driven API jobs.
- **Future Evolution**: BullMQ/Redis and multi-worker execution can be added later without changing plugin contracts.

#### 1. Apify-Alike Solution Based on Crawlee
The core is a Crawlee-based "Actor-like" system for crawling/scraping. Crawlee handles queues, proxies, retries, and browser/HTTP modes. We emulate Apify's Actor lifecycle (init, run, exit) without the cloud platform.

- **Architecture**:
  - **Crawler Engine**: Use `BasicCrawler` for RSS/HTTP feeds; switch to `PlaywrightCrawler` for dynamic sites (e.g., transcripts behind JS).
  - **Sentiment Integration**: VADER for analysis, with asset extraction (regex/NER for tickers like AAPL).
  - **Storage**: Local MongoDB (or SQLite for small scale) for scraped data; export to CSV/JSON.
  - **Scheduling**: Node-cron for jobs; queue with BullMQ (Redis-based) for async runs.
  - **Stealth**: Built-in proxy rotation and user-agent randomization to avoid bans.
  - **Workflow**: Jobs triggered via API or schedule; process: Fetch → Parse → Extract → Analyze → Store.
  - **Compliance Guardrails**: Per-source rate limits, source metadata flags for terms/restrictions, and explicit support for summary-only scraping where full-text retrieval is not allowed.

- **Example Core Logic** (in `core/crawler.js`):
  ```js
  const { BasicCrawler } = require('crawlee');
  const vader = require('vader-sentiment');
  const got = require('got');
  const { parseStringPromise } = require('xml2js');
  const _ = require('lodash');
  const mongoose = require('mongoose'); // For MongoDB storage

  // Schema for stored data
  const ArticleSchema = new mongoose.Schema({
    source: String,
    title: String,
    content: String,
    sentiment: Object,
    assets: [String],
    timestamp: Date
  });
  const Article = mongoose.model('Article', ArticleSchema);

  async function runCrawler(config) { // config from JSON/YAML
    const crawler = new BasicCrawler({
      maxConcurrency: config.concurrency || 5,
      async requestHandler({ request }) {
        // Fetch and parse (RSS-specific; extend for others)
        const xml = await got(request.url).text();
        const parsed = await parseStringPromise(xml);
        const items = _.get(parsed, 'rss.channel[0].item', []);

        for (const item of items) {
          const content = item.description[0] || '';
          const scores = vader.SentimentIntensityAnalyzer.polarity_scores(content);
          const assets = content.match(/\b[A-Z]{2,5}\b/g) || [];

          await Article.create({
            source: config.source,
            title: item.title[0],
            content,
            sentiment: scores,
            assets: _.uniq(assets),
            timestamp: new Date()
          });
        }
      }
    });

    await crawler.run(config.urls.map(url => ({ url })));
  }

  module.exports = { runCrawler };
  ```

- **Apify Emulation**: Wrap in a CLI like `apify run` using Commander.js for local execution.

#### 2. Plug-and-Play Modularized Design
- **Abstraction**: Data sources abstracted as plugins (e.g., `plugins/rss.js`, `plugins/transcripts.js`). Each plugin exports a handler for fetching/parsing.
- **Declarative Driven**: Sources defined in JSON/YAML metadata files (e.g., `sources.yaml`). This drives configuration: URLs, parsers, filters, extensions.
- **Extension/Customization**: Add new sources by creating a plugin file and updating YAML. Custom logic via hooks (e.g., pre/post-process functions).
- **Example YAML Config** (`config/sources.yaml`):
  ```yaml
  sources:
    google-news:
      type: rss
      urls:
        - https://news.google.com/rss/search?q=site:reuters.com%20business
        - https://news.google.com/rss/search?q=site:reuters.com%20company
        - https://news.google.com/rss/search?q=site:reuters.com%20technology
        - https://news.google.com/rss/search?q=site:reuters.com%20commodities
      parser: xml2js
      filters:
        keywords: [stock, market, earnings]
      extensions:
        fullArticle: false  # Enqueue links for full scrape
    bloomberg:
      type: rss
      urls:
        - https://www.bloomberg.com/feeds/bbiz/sitemap_news.xml
        - https://www.bloomberg.com/feeds/economy/sitemap_news.xml
      parser: xml2js
      customHook: bloombergPostProcess  # JS function for site-specific tweaks
      headers:
        userAgent: Mozilla/5.0
    seekingAlpha:
      type: transcripts
      urls:  # Dynamic, e.g., per ticker
        - https://seekingalpha.com/symbol/{ticker}.xml
      params:
        tickers: [AAPL, TSLA]
      parser: xml2js
      extensions:
        fullArticle: true  # Scrape transcripts
    nytimes:
      type: rss
      urls:
        - https://rss.nytimes.com/services/xml/rss/nyt/Business.xml
        - https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml
        - https://rss.nytimes.com/services/xml/rss/nyt/Dealbook.xml
      parser: xml2js
      filters:
        keywords: [market, economy, inflation, fed, merger]
    cnbc:
      type: rss
      urls:
        - https://www.cnbc.com/id/100727362/device/rss/rss.html
      parser: xml2js
  ```
- **Loading Mechanism**: Use `js-yaml` to parse YAML; dynamically load plugins based on `type`.
- **Flexibility**: For custom sources (e.g., Reddit API), add `type: api` with auth keys in YAML.
- **Runtime Expansion**: Support placeholder expansion for feeds such as `https://seekingalpha.com/symbol/{ticker}.xml` using params from YAML.
- **Normalization**: Plugins should normalize source-specific feed shapes into a shared article model before sentiment analysis.

#### 3. REST API Wrapper with Swagger Specs
- **Framework**: Express.js with Swagger UI for docs.
- **Endpoints**:
  - `/api/sources`: GET (list), POST (add/edit YAML-driven source), DELETE.
  - `/api/scrapers`: POST (trigger scrape job), GET (status).
  - `/api/schedulers`: POST (add cron job), GET (list active).
  - `/api/jobs`: GET (monitor running/completed, with logs).
  - `/api/analysis`: GET (query stored data by source/asset/sentiment).
  - `/api/health`: GET (liveness/readiness for local deployment and container probes).
- **Swagger Integration**: Use `swagger-ui-express` and `swagger-jsdoc` to auto-generate specs from JSDoc.
- **Example Server** (`server.js`):
  ```js
  const express = require('express');
  const swaggerUi = require('swagger-ui-express');
  const swaggerJsdoc = require('swagger-jsdoc');
  const { runCrawler } = require('./core/crawler');
  const yaml = require('js-yaml');
  const fs = require('fs');

  const app = express();
  app.use(express.json());

  const options = { definition: { openapi: '3.0.0', info: { title: 'FinScrapeSentiment API', version: '1.0.0' } }, apis: ['./server.js'] };
  const specs = swaggerJsdoc(options);

  /**
   * @swagger
   * /api/scrapers:
   *   post:
   *     summary: Trigger a scrape job
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               source: { type: string }
   *     responses:
   *       200: { description: Job started }
   */
  app.post('/api/scrapers', async (req, res) => {
    const config = yaml.load(fs.readFileSync('config/sources.yaml', 'utf8')).sources[req.body.source];
    await runCrawler(config);
    res.json({ status: 'started' });
  });

  // Add other endpoints...

  app.listen(3000, () => console.log('API on port 3000'));
  ```
- **Auth/Security**: Add JWT for production.
- **Operational Security for MVP**: Local-first deployment can start without auth, but production should add API auth, secrets management for premium sources, request logging, and rate limiting.

#### 4. Development Pipeline Support and Automation Test Methodology
- **Pipeline**: Use GitHub Actions/Jenkins for CI/CD: Lint (ESLint), Build (Docker), Test, Deploy.
- **Testing Methodology**:
  - **Unit Tests**: Jest for individual modules (e.g., parser, sentiment).
  - **Integration Tests**: Mock HTTP responses (Nock) to verify scraping flow.
  - **E2E Tests**: Cypress for API; simulate jobs and check DB outputs.
  - **Verification**: Compare scraped data against golden samples (JSON fixtures); assert sentiment scores within thresholds (e.g., negative for "plunge").
  - **Automation**: Run on PRs; coverage >80%. Use fixtures for sources to avoid live scraping in tests.
- **Practical MVP Test Scope**:
  - Unit tests for config loading, sentiment scoring, asset extraction, URL expansion, and plugin normalization.
  - Integration tests for mocked RSS/transcript fetches and persisted analysis output.
  - API tests for source listing, job triggering, scheduler registration, and analysis filtering.
  - Avoid live network dependence in CI; all tests should run from fixtures and mocks.

#### 5. Detailed Step-by-Step Guides for Using the Service with Different Data Sources
Assume service is running locally (node server.js). Use API or CLI for interaction.

- **Google News financial feed (Reuters links)**:
  1. Edit `sources.yaml` to add a `google-news` config entry pointing at Google News RSS queries filtered to Reuters (example above).
  2. POST to `/api/sources` with YAML snippet if dynamic.
  3. POST to `/api/scrapers` with `{ "source": "google-news" }` to trigger.
  4. Monitor via GET `/api/jobs`.
  5. Query results: GET `/api/analysis?source=google-news` → JSON with sentiment.

- **Bloomberg (RSS/Sitemap)**:
  1. Add to YAML: Use sitemap URLs; set `customHook` for Bloomberg-specific XML quirks.
  2. Trigger scrape via API.
  3. If blocked, add proxies in YAML (`proxies: [list]`).
  4. Results include sentiment; export for asset tracking.

- **New York Times (RSS)**:
  1. Add NYT feeds to YAML.
  2. Enable `scrapeFullArticles: true` if paywall allows (use browser mode).
  3. Trigger and monitor as above.
  4. Filter by keywords in YAML for finance focus.

- **Seeking Alpha (Transcripts/RSS)**:
  1. In YAML, set `type: transcripts`; use dynamic `{ticker}` placeholders.
  2. Provide tickers in params.
  3. Trigger: Service replaces placeholders (e.g., for AAPL).
  4. Scrape full transcripts via link enqueuing.
  5. Analyze: VADER on detailed earnings text.

- **Others (e.g., WSJ, FT, CNBC)**:
  1. Add similar YAML entries.
  2. For paywalled (WSJ), add login credentials in secure YAML section (use Playwright for auth).
  3. Trigger/monitor uniformly.

#### 6. Operational Constraints and Feed-Specific Notes
- **Google News financial feed (Reuters links)**: RSS is the easiest starting point; prefer headline/summary ingestion first and add full-article retrieval only where permitted.
  - Legacy `feeds.reuters.com` endpoints should be treated as deprecated in practice; the implementation may need a maintained fallback feed or an alternate ingestion path for Reuters-linked content.
- **Bloomberg**: Public feeds may behave more like sitemap feeds than classic RSS; normalize parser behavior accordingly.
- **New York Times**: Official RSS coverage is strong, but full article scraping may run into metered/paywall concerns.
- **Seeking Alpha**: Symbol-based feeds are useful for transcript-style workflows; use placeholder expansion and ticker allowlists.
- **Reddit and X**: Keep these as future plugin categories with separate auth/rate-limit handling instead of forcing them into the RSS MVP.
- **Legal/Compliance**: Track source terms, avoid aggressive scrape frequency, and preserve original links and timestamps for auditability.

#### 7. Deployment Workflow
- **Local Run**: Start the API server, trigger scrapes through REST or CLI, and store results locally.
- **Container Deployment**: Build a Docker image, mount config and data volumes, expose the API port, and schedule jobs internally or externally.
- **Apify Migration Path**: If cloud execution is later required, keep crawler/plugin contracts decoupled from storage and API layers so an Actor wrapper can be added without rewriting core logic.

### Implementation Plans: Epics, Stories, Unit/Automation Test Plans

#### Epic 1: Core Scraping Engine
- **Story 1.1**: Implement Crawlee-based crawler with RSS parsing.
  - Tasks: Code `crawler.js`; integrate VADER.
  - Unit Tests: Test parsing with mock XML (Jest: assert items extracted).
  - Automation Tests: E2E with Nock mocks; verify DB insert.

- **Story 1.2**: Add sentiment and asset extraction.
  - Tasks: Regex for tickers; VADER scoring.
  - Unit Tests: Input strings → expected scores (e.g., "stock plunge" → negative).
  - Automation Tests: Pipeline run with fixtures.

#### Epic 2: Modular Data Sources
- **Story 2.1**: YAML-driven config loader.
  - Tasks: Parse YAML; dynamic plugin loading.
  - Unit Tests: Invalid YAML → error; valid → config object.
  - Automation Tests: Load and run sample source.

- **Story 2.2**: Plugins for RSS/Transcripts.
  - Tasks: Create `plugins/rss.js`, `plugins/transcripts.js`.
  - Unit Tests: Plugin handlers with mocks.
  - Automation Tests: End-to-end scrape for each type.

#### Epic 3: REST API and Management
- **Story 3.1**: Build Express API endpoints.
  - Tasks: Sources/Scrapers/Schedulers/Jobs routes.
  - Unit Tests: API responses (Supertest).
  - Automation Tests: Cypress for UI interactions (Swagger).

- **Story 3.2**: Integrate Swagger.
  - Tasks: JSDoc → specs.
  - Unit Tests: N/A.
  - Automation Tests: Validate OpenAPI schema.

#### Epic 4: Scheduling and Monitoring
- **Story 4.1**: Cron/BullMQ integration.
  - Tasks: API to add schedules.
  - Unit Tests: Mock cron triggers.
  - Automation Tests: Simulate job run and status check.

#### Epic 5: Dev Pipeline and Testing
- **Story 5.1**: Set up CI/CD with GitHub Actions.
  - Tasks: YAML workflow for lint/test/build.
  - Unit Tests: Coverage reports.
  - Automation Tests: PR gates.

- **Story 5.2**: Implement verification tests.
  - Tasks: Fixtures for golden data comparison.
  - Unit Tests: Sentiment thresholds.
  - Automation Tests: Full pipeline with mock sources.

Timeline: 4-6 weeks for MVP (assuming 1-2 devs). Start with Epic 1. Use Docker for deployment.