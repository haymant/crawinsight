# CrawlInsight

Local financial feed scraping and VADER sentiment analysis service.

## Features

- YAML-driven source configuration
- Plugin-based RSS and transcript feed handling
- VADER sentiment analysis with asset extraction
- Express API (no embedded docs)
- Cron scheduler for recurring scrapes
- File-backed persistence for scraped articles
- Mock-based test suite with no live network dependency

## Quick start

```bash
npm install
# test against mock feeds
npm test
# test real sites
LIVE=true npm test
npm start
```

The API listens on port `3000` by default.

## Source notes

- The legacy `feeds.reuters.com` RSS host is no longer reliable. The default source now pulls a **Google News financial feed filtered to Reuters links** so that the service works out of the box; the internal key is `google-news`.
- Bloomberg uses a sitemap-style XML feed and Seeking Alpha uses symbol-driven RSS feeds.
- Reddit support is available through the `reddit` plugin. The default config now uses subreddit JSON listings in browser mode rather than RSS.
- Browser mode uses Playwright with a shared authenticated context, reads credentials from `.env.local` using `REDDIT_USERNAME`/`REDDIT_PASSWORD` (with backward-compatible support for `REDDIT_USER`/`REDDIT_PASS`), and throttles Reddit access according to `MAX_REQUESTS_PER_SOURCE_MINUTE` (default 5). Use `.env.local` to tune the rate limit.
- Reddit may still block anonymous traffic from some networks. In that case the plugin retries through the authenticated browser session before falling back to page extraction. Mocked tests cover the parser and service flow; optional LIVE tests are designed to validate either successful access or a clear failure path.
- **New:** X.com (formerly Twitter) support is available via the `x` plugin. It only works in browser mode and requires valid credentials in `.env.local` (`X_USERNAME` and `X_PASSWORD`). The X plugin can scrape public lists, account timelines, or hashtag searches; see `docs/X.md` for design details. X access is also throttled by `MAX_REQUESTS_PER_SOURCE_MINUTE`. You can force Playwright to run visibly by setting `X_HEADLESS=false` in the environment; this is useful for completing manual login challenges. If you configure an X source, add a `urls` entry with the desired list/search URL and set `options.browser: true`.
- Feed availability and anti-bot behavior can change; if a source stops resolving, update `config/sources.yaml` rather than assuming the scraper is broken.

## CLI

Run a single source from the command line. The argument is the **source key** as defined in `config/sources.yaml` (defaults shown):

```bash
npm run cli -- google-news   # Google News financial feed (Reuters links)
npm run cli -- bloomberg
npm run cli -- nytimes
npm run cli -- seekingalpha
npm run cli -- cnbc
npm run cli -- reddit-stocks
npm run cli -- x-financial-list   # example X.com list or timeline
```
After the CLI completes you can inspect the persisted `data/articles.json` file or hit the API to verify results.

If a source is unreachable, the CLI now exits with an error instead of returning a misleading zero-result success payload.

For Reddit browser mode, place credentials in `.env.local` before running the CLI:

```bash
REDDIT_USERNAME=your_username
REDDIT_PASSWORD=your_password
```

For X browser mode the first login attempt may trigger a manual challenge (2FA, captcha,
For X browser mode the first login attempt will always prompt for your
phone number (or email) before showing the password field.  The plugin now
steps through that secondary prompt automatically, but if X presents any other
challenge (captcha, 2FA page, etc.) it will throw the message
`X login challenge requires manual verification`.

When operating interactively you can supply `X_HEADLESS=false` and the plugin
will pause right before giving up, opening a visible Chromium window with
devtools attached; you can then enter the required information or solve the
captcha and click ▶︎ to resume the script.  Once a session is established the
state is stored in `data/.x-auth.json` and future runs should succeed
headlessly.

If the challenge cannot be solved programmatically you can also log in manually
with a normal browser and copy the storage state file.

Keep `X_USERNAME`/`X_PASSWORD` set in `.env.local` so the plugin can refresh
and reuse that state when it expires.


## Default data path

Articles are written to `data/articles.json` unless overridden with `DATA_PATH`.

## REST API curl examples

Below is a sequence of `curl` commands that mirror the SIT flow and can be used to exercise the service manually.

1. **Add sources** (names must match the keys you intend to use):

```bash
curl -X POST http://localhost:3000/api/sources \
  -H 'Content-Type: application/json' \
  -d '{"name":"google-news","config":{ "displayName":"Google Financial News (Reuters links)","type":"rss","urls":["https://news.google.com/rss/search?q=site:reuters.com%20markets"],"filters":{"keywords":["market","earnings"]}}}'
```

Repeat the POST for `bloomberg`, `nytimes`, `seekingalpha`, `cnbc`, and `reddit-stocks` (or use the ones in `docs/DESIGN.md`).

Reddit example:

```bash
curl -X POST http://localhost:3000/api/sources \
  -H 'Content-Type: application/json' \
  -d '{"name":"reddit-stocks","config":{"displayName":"Reddit Stocks","type":"reddit","urls":["https://www.reddit.com/r/{subreddit}/hot.json?limit=25"],"params":{"subreddits":["stocks","finance"]},"headers":{"userAgent":"Mozilla/5.0"},"filters":{"keywords":["earnings","market","stock","guidance","portfolio","trading","rates","fed"]},"options":{"maxItemsPerFeed":15,"browser":true}}}'
```

2. **Verify sources added**:

```bash
curl http://localhost:3000/api/sources | jq
```

3. **Trigger a scraper run** for each source:

```bash
curl -X POST http://localhost:3000/api/scrapers -H 'Content-Type: application/json' -d '{"source":"google-news"}'
```

Run the same command with other source keys (`bloomberg`, `reddit-stocks`, etc.).

4. **Create schedulers** (optional):

```bash
curl -X POST http://localhost:3000/api/schedulers \
  -H 'Content-Type: application/json' \
  -d '{"name":"hourly-google","source":"google-news","expression":"0 * * * *"}'
```

5. **Check job status**:

```bash
curl http://localhost:3000/api/jobs | jq
```

Each job record will include `status` and counts of fetched/stored articles.

6. **Verify analysis results**:

```bash
curl "http://localhost:3000/api/analysis?source=google-news" | jq
```

Look for `articles` with `sentiment` and `sentimentType` fields populated.

The same query can be run with other source keys (e.g. `source=bloomberg`).

For Reddit-specific validation, filter by subreddit as well:

```bash
curl "http://localhost:3000/api/analysis?source=reddit-stocks&subreddit=stocks" | jq
```
