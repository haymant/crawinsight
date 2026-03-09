### Reddit Source Extension Plan for CrawInsight

This note revises the earlier Reddit research into a plan that fits the current CrawInsight repository rather than a hypothetical larger platform.

The service in this repo currently uses:
- CommonJS on Node.js.
- Crawlee `BasicCrawler` plus `axios` for fetches.
- File-backed persistence in `data/articles.json`.
- Generic source definitions in `config/sources.yaml`.
- Generic source management through `/api/sources`, `/api/scrapers`, and `/api/analysis`.
- Jest, Supertest, and Nock for automated tests, with optional `LIVE=true` runs against real sites.

The earlier Reddit draft was misaligned in several places. This repo does not currently use MongoDB, Playwright, BullMQ, Cypress, or Swagger. Those can remain future options, but they should not drive the MVP implementation here.

#### 1. MVP Decision

For this codebase, Reddit should be implemented as a new `reddit` plugin that plugs into the existing `CrawlService` contract:
- `expandRequests(source)` returns request descriptors.
- `parse({ body, metadata })` returns normalized article-like objects.

The MVP should support:
- Reddit JSON listing feeds such as `https://www.reddit.com/r/{subreddit}/hot.json?limit=25`.
- **Browser mode**: a real headless browser crawl (via Playwright) for pages that block simple HTTP clients. This is enabled by setting `options.browser: true` on the source, honours optional login credentials, and reuses authenticated state between requests.
- DOM extraction fallback from the rendered subreddit listing page if the in-browser JSON fetch still does not return a parseable listing.
- Generic YAML source configuration, not Reddit-specific API routes.
- Reuse of the existing VADER analysis and article repository.

The MVP should not require:
- OAuth credentials.
- New storage backends.
- A new queueing system.

#### 2. Why This Fits the Current Service

- `BasicCrawler` already handles execution, retries, and deduplicated per-run request keys.
- `axios` already fetches both XML and JSON.
- The repository can already persist extra fields without a schema migration.
- The existing REST API already manages heterogeneous sources cleanly.

The only API extension worth adding for MVP is optional analysis filtering by `subreddit`, because that materially improves Reddit usability without creating a parallel API surface.

#### 3. Source Definition

Reddit should be a first-class source type using the same YAML conventions as the existing RSS and transcript sources.

```yaml
sources:
  reddit-stocks:
    displayName: Reddit Stocks
    type: reddit
    urls:
      - https://www.reddit.com/r/{subreddit}/hot.json?limit=25
    params:
      subreddits:
        - stocks
        - finance
    headers:
      userAgent: Mozilla/5.0
    filters:
      keywords:
        - earnings
        - market
        - stock
        - guidance
    options:
      maxItemsPerFeed: 15
      browser: true
```

Design notes:
- `urls` stays mandatory because `SourceConfigService` currently validates it.
- `params.subreddits` should expand exactly like transcript tickers expand today.
- Browser-backed JSON should be the default live path because anonymous Reddit traffic is currently blocked from some networks used by this repo.
- The plugin should still accept RSS in `parse()` for fixtures and compatibility, but the default source should no longer depend on RSS.

#### 4. Plugin Contract

Browser mode is implemented by providing a `fetchWithBrowser(url, headers)` helper on the plugin. When `source.options.browser` is truthy, `CrawlService` will call this helper instead of `axios`.

The helper uses Playwright to launch a headless Chromium instance, optionally log in with credentials read from `.env.local`, persist authenticated storage state under `data/.reddit-auth.json`, and serialize Reddit requests according to the `MAX_REQUESTS_PER_SOURCE_MINUTE` environment variable (default 5):

```env
REDDIT_USERNAME=your_username
REDDIT_PASSWORD=your_password
```

You only need credentials if anonymous browser fetches are blocked on your network. The plugin also accepts `REDDIT_USER` / `REDDIT_PASS` for backward compatibility. Both `src/index.js` and `src/cli.js` load these vars via `dotenv`.

#### 4. Plugin Contract

Create `src/plugins/reddit.js` and register it in `src/plugins/index.js`.

Expected behavior:
- `expandRequests(source)`
  - Expand `{subreddit}` placeholders from `params.subreddits`.
  - Attach metadata such as `subreddit` to each generated request.
- `parse({ body, metadata })`
  - If the body is a Reddit JSON listing, normalize `data.children` records.
  - If the body is an array returned by browser extraction, accept it as already-normalized Reddit items.
  - Otherwise, parse as RSS and enrich each item with `metadata.subreddit`.

Normalized Reddit items should look like this (browser mode returns the same shape):

```js
{
  title,
  link,
  publishedAt,
  summary,
  content,
  subreddit,
  score,
  commentCount
}
```

`content` should prefer selftext when present. Sentiment scoring and ticker extraction can continue to run through the existing `analyzeArticle` path.

#### 5. API and Query Surface

Do not add Reddit-only endpoints.

Use the existing generic endpoints:
- `POST /api/sources` to add a Reddit source.
- `POST /api/scrapers` to trigger it.
- `GET /api/jobs` to inspect job results.
- `GET /api/analysis?source=reddit-stocks` to query sentiment output.

Small MVP extension:
- Add `subreddit` filtering to `/api/analysis` and `ArticleRepository.query()`.

That keeps the operational interface consistent across all source types.

#### 6. CLI and Manual Validation

The CLI already supports the right execution model:

```bash
npm run cli -- reddit-stocks
```

Manual REST validation should follow the same generic flow as other sources:

```bash
curl -X POST http://localhost:3000/api/sources \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"reddit-stocks",
    "config":{
      "displayName":"Reddit Stocks",
      "type":"reddit",
      "urls":["https://www.reddit.com/r/{subreddit}/hot.json?limit=25"],
      "params":{"subreddits":["stocks","finance"]},
      "headers":{"userAgent":"Mozilla/5.0"},
      "filters":{"keywords":["earnings","market","stock"]},
      "options":{"maxItemsPerFeed":15,"browser":true}
    }
  }'

curl -X POST http://localhost:3000/api/scrapers \
  -H 'Content-Type: application/json' \
  -d '{"source":"reddit-stocks"}'

curl "http://localhost:3000/api/analysis?source=reddit-stocks&subreddit=stocks" | jq
```

README should include both the CLI sample and the subreddit-filtered analysis sample.

#### 7. Test Plan Required for This Repo

Tests must match the repo's current fixture-first and optional-live approach.

Required coverage:

1. Plugin unit tests using fixtures.
- Parse mocked Reddit JSON listing payload.
- Parse mocked Reddit RSS payload.
- Expand URL templates from `params.subreddits`.

2. Service-level tests with mocked network.
- Run a Reddit source through `CrawlService` using Nock.
- Assert persisted records include `subreddit` and sentiment fields.
- Assert analysis filtering by `subreddit` works.

3. API and SIT coverage.
- Add a Reddit source through the generic API.
- Trigger a scrape.
- Query `/api/analysis?source=reddit-stocks&subreddit=stocks`.

4. Optional LIVE coverage.
- When `LIVE=true`, exercise a real browser-backed JSON endpoint such as `https://www.reddit.com/r/stocks/hot.json?limit=25`.
- Keep LIVE assertions minimal: verify either a successful scrape or a clear blocked-site failure path, because Reddit may still block or challenge some sessions.
- Do not require live network access in default CI.

This is the minimum testing bar for a Reddit source in this service.

#### 8. Implementation Sequence

1. Add the `reddit` plugin and register it.
2. Add `subreddit` query support in the repository and API.
3. Add Reddit fixtures for RSS and JSON.
4. Add unit, service, and SIT coverage using mocked data.
5. Add optional LIVE coverage using Reddit browser-backed JSON.
6. Add a default Reddit source to `config/sources.yaml`.
7. Update README with CLI and curl examples.

#### 9. Explicitly Deferred

The following are valid future work but not part of this implementation:
- Playwright scraping of full threads and comment trees.
- OAuth-backed Reddit API access.
- Proxy rotation and bot-evasion controls beyond custom user-agent support.
- Dedicated rate-limiting or queueing infrastructure beyond the plugin-local 5-requests-per-minute guard.
- Reddit-specific management endpoints.

That scope keeps the change consistent with this repo and small enough to test reliably.