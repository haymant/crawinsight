### X Source Extension Plan for CrawlInsight

This note defines support for scraping X.com lists and finance-focused timelines within the current CrawlInsight codebase.

The implementation needs to fit the existing service shape:
- CommonJS on Node.js.
- `CrawlService` built on Crawlee `BasicCrawler`.
- Generic source definitions from `config/sources.yaml`.
- Browser-backed fetch support through per-plugin `fetchWithBrowser(url, headers)` helpers.
- File-backed article persistence in `data/articles.json`.
- Jest-based unit and integration tests with optional live tests enabled by environment variables.

The goal is not to build a general X API client. The goal is to add a pragmatic `x` source type that can authenticate with Playwright, scrape one or more configured list or search URLs, normalize posts into the existing article model, and reuse the current sentiment pipeline.

#### 1. MVP Scope

The MVP should support two X source patterns:

1. Direct list URLs.
	 Example:
	 `https://x.com/i/lists/2030824480940146987`

2. Template-driven URLs expanded from source params.
	 Examples:
	 - account timelines or searches:
		 `https://x.com/search?q=from%3A{account}%20filter%3Alinks&src=typed_query&f=live`
	 - tag searches:
		 `https://x.com/search?q=%23{tag}%20filter%3Alinks&src=typed_query&f=live`

The MVP should not depend on the official X API.

The MVP should:
- Use Playwright for page loading and authenticated browser sessions.
- Load credentials from `X_USERNAME` and `X_PASSWORD`.
- Persist login state under `data/.x-auth.json`.
- Support browser throttling using the existing `MAX_REQUESTS_PER_SOURCE_MINUTE` environment variable.
- Normalize extracted posts into article-like records for the existing sentiment pipeline.

The MVP should not attempt:
- DMs, notifications, or user-private data.
- Posting or mutating actions.
- Deep thread expansion beyond what is visible in the loaded page.
- Full anti-bot or captcha solving.

#### 2. Source Configuration

X should be a new source type named `x` and use the same generic source config model as the other plugins.

##### 2.1 Single list feed

Use a single URL in `urls` and enable browser mode:

```yaml
sources:
	x-financial-list:
		displayName: X Financial Market List
		type: x
		urls:
			- https://x.com/i/lists/2030824480940146987
		headers:
			userAgent: Mozilla/5.0
		filters:
			keywords:
				- market
				- earnings
				- rates
				- stock
		options:
			browser: true
			maxItemsPerFeed: 20
```

##### 2.2 Generic account search expansion

```yaml
sources:
	x-finance-accounts:
		displayName: X Finance Accounts
		type: x
		urls:
			- https://x.com/search?q=from%3A{account}%20filter%3Alinks&src=typed_query&f=live
		params:
			accounts:
				- zerohedge
				- markets
		headers:
			userAgent: Mozilla/5.0
		options:
			browser: true
			maxItemsPerFeed: 20
```

##### 2.3 Generic hashtag expansion

```yaml
sources:
	x-finance-tags:
		displayName: X Finance Tags
		type: x
		urls:
			- https://x.com/search?q=%23{tag}%20filter%3Alinks&src=typed_query&f=live
		params:
			tags:
				- stocks
				- fed
				- oil
		headers:
			userAgent: Mozilla/5.0
		options:
			browser: true
			maxItemsPerFeed: 20
```

Notes:
- Direct URLs are enough for a single list source.
- Param expansion should reuse the current URL-template pattern already used by RSS and Reddit.
- For X, `options.browser: true` is required in practice because the content is rendered dynamically and commonly gated.

#### 3. Normalized Data Model

The `x` plugin should normalize extracted posts into the shared article shape, with X-specific metadata preserved as extra fields.

Normalized items should look like:

```js
{
	title,
	link,
	publishedAt,
	summary,
	content,
	author,
	handle,
	listId,
	tag,
	likeCount,
	repostCount,
	replyCount,
}
```

Field guidance:
- `title`: first 120 characters of the post text, or the full post text if shorter.
- `content`: full visible tweet/post text.
- `summary`: same as `content` for the MVP.
- `link`: canonical status URL.
- `author`: visible display name if available.
- `handle`: `@screen_name` without the `@` if available.
- `listId`: extracted from `metadata.listId` or from the URL.
- `tag`: from expanded metadata when the source is based on `params.tags`.

This keeps compatibility with the current analysis flow while adding useful query dimensions.

#### 4. Authentication and Browser Session

Authentication should be handled entirely inside `src/plugins/x.js`.

Required environment variables:

```env
X_USERNAME=your_username_or_email
X_PASSWORD=your_password
```

Behavior:
- Load saved auth state from `data/.x-auth.json` when present.
- If not authenticated, open the X login flow with Playwright.
- Fill username and password, then wait for navigation to the authenticated app shell.
- Save storage state back to `data/.x-auth.json`.
- Reuse the stored state for later requests.

Pragmatic constraints:
- X sometimes prompts for additional challenges such as email, phone, or suspicious-login verification.
- The plugin should treat that as a clear fetch failure rather than trying to automate every challenge path.
- Live tests should allow this failure mode and report it cleanly.

#### 5. Request Expansion and Metadata

The X plugin should reuse template expansion behavior from the RSS plugin.

Expected metadata handling:
- `params.accounts` should yield `metadata.account`.
- `params.tags` should yield `metadata.tag`.
- direct list URLs should infer `metadata.listId` from the URL when possible.

That means a single plugin can support:
- one explicit list URL,
- multiple lists listed directly in `urls`,
- account-driven search templates,
- hashtag-driven search templates.

#### 6. Browser Fetch Strategy

`fetchWithBrowser(url, headers)` should:
- serialize requests through a shared queue,
- respect `MAX_REQUESTS_PER_SOURCE_MINUTE`,
- create a Playwright browser context with a realistic user agent,
- ensure login before loading the target page,
- open the target page,
- wait for visible tweet/article nodes,
- scroll a limited number of times to load enough items,
- extract normalized post objects in the page context,
- return an array of normalized items.

Selectors should be resilient but simple:
- target `article[data-testid="tweet"]` as the primary tweet node,
- use anchor URLs containing `/status/` for canonical links,
- derive author and handle from text and profile links,
- ignore ads and non-post cards when the canonical status URL cannot be found.

#### 7. Parse Contract

The plugin contract should stay consistent with the other sources.

`expandRequests(source)`:
- reuse generic URL expansion.
- attach metadata from params.
- add inferred `listId` when the expanded URL is an X list URL.

`parse({ body, metadata })`:
- if `body` is already an array, treat it as browser-extracted X items,
- enrich missing `listId`, `account`, or `tag` from metadata,
- return normalized article-like records.

The X plugin does not need an RSS fallback.

#### 8. Storage and Query Support

To make X data operationally useful, the repository and API query path should support these optional filters:
- `author`
- `handle`
- `listId`
- `tag`

This is the same pattern already used for `subreddit` on Reddit and `asset` on transcripts.

API example:

```bash
curl "http://localhost:3000/api/analysis?source=x-financial-list&listId=2030824480940146987" | jq
```

#### 9. Implementation Plan

1. Create `src/plugins/x.js`.
2. Register the plugin in `src/plugins/index.js`.
3. Reuse RSS-style URL expansion, but enrich metadata with inferred X list IDs.
4. Add Playwright session handling, login flow, request throttling, and DOM extraction.
5. Extend repository filtering for X-specific metadata.
6. Extend `/api/analysis` query handling to accept `author`, `handle`, `listId`, and `tag`.
7. Add fixture-based unit tests for normalization and request expansion.
8. Add service-level tests with mocked browser fetch.
9. Add optional live tests gated by environment variables.

#### 10. Test Plan

The X implementation must include both deterministic tests and optional real-site validation.

##### 10.1 Unit tests with fixtures and mock data

Required coverage:
- expand a list of account templates from `params.accounts`.
- expand a list of tag templates from `params.tags`.
- infer `listId` from direct list URLs.
- normalize browser-returned X items.
- respect `MAX_REQUESTS_PER_SOURCE_MINUTE` when computing throttle interval.

These tests should not open a real browser.

##### 10.2 Service-level integration tests with mocked browser fetch

Required coverage:
- run an `x` source through `CrawlService` with `options.browser: true`.
- mock `plugin.fetchWithBrowser()` to return normalized items.
- verify persisted records include X metadata fields.
- verify repository and `/api/analysis` filtering by `listId`, `handle`, and `tag`.

These tests should not depend on live X access.

##### 10.3 Optional live tests

Live tests should be opt-in only and skipped by default.

Suggested gating:
- `LIVE=true`
- `X_USERNAME` and `X_PASSWORD` present

Required live scenarios:
1. A direct list URL such as `https://x.com/i/lists/2030824480940146987`.
2. A search template such as `from:{account}` or `#{tag}`.

Live assertions should stay minimal:
- the fetch returns at least one normalized item, or
- the plugin throws a clear, diagnosable auth or access error.

Because X frequently changes login and anti-bot flows, the live suite should accept a known-challenge failure if the message is explicit.

#### 11. Operational Notes

- Use a realistic user agent in browser mode.
- Keep scroll depth bounded to avoid turning one feed load into an unbounded scrape.
- Prefer canonical status URLs for deduplication.
- Treat X UI changes as expected operational churn and keep selectors centralized in the plugin.
- Keep the plugin read-only and summary-oriented.
