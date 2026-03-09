# CrawInsight

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
- Feed availability and anti-bot behavior can change; if a source stops resolving, update `config/sources.yaml` rather than assuming the scraper is broken.

## CLI

Run a single source from the command line. The argument is the **source key** as defined in `config/sources.yaml` (defaults shown):

```bash
npm run cli -- google-news   # Google News financial feed (Reuters links)
npm run cli -- bloomberg
npm run cli -- nytimes
npm run cli -- seekingalpha
npm run cli -- cnbc
```

After the CLI completes you can inspect the persisted `data/articles.json` file or hit the API to verify results.

If a source is unreachable, the CLI now exits with an error instead of returning a misleading zero-result success payload.

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

Repeat the POST for `bloomberg`, `nytimes`, `seekingalpha`, `cnbc` (or use the ones in `docs/DESIGN.md`).

2. **Verify sources added**:

```bash
curl http://localhost:3000/api/sources | jq
```

3. **Trigger a scraper run** for each source:

```bash
curl -X POST http://localhost:3000/api/scrapers -H 'Content-Type: application/json' -d '{"source":"google-news"}'
```

Run the same command with other source keys (`bloomberg`, etc.).

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
