const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const rssPlugin = require('./rss');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 CrawInsight/1.0';
// throttle derived from environment variable or default 5 requests per minute
const MAX_REQS = Number(process.env.MAX_REQUESTS_PER_SOURCE_MINUTE) || 5;
const REDDIT_REQUEST_INTERVAL_MS = Math.ceil(60000 / MAX_REQS);

let browserFetchQueue = Promise.resolve();
let lastRedditRequestAt = 0;

function normalizePost(post, fallbackSubreddit) {
  const permalink = post.permalink ? `https://www.reddit.com${post.permalink}` : '';
  return {
    title: post.title || '',
    link: permalink || post.url || '',
    publishedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
    summary: post.selftext || '',
    content: post.selftext || post.title || '',
    subreddit: post.subreddit || fallbackSubreddit || null,
    score: typeof post.score === 'number' ? post.score : null,
    commentCount: typeof post.num_comments === 'number' ? post.num_comments : null,
  };
}

function normalizeBrowserPost(post, fallbackSubreddit) {
  if (!post || typeof post !== 'object') {
    return null;
  }

  if (post.permalink || post.created_utc || post.selftext !== undefined) {
    return normalizePost(post, fallbackSubreddit);
  }

  const permalink = post.link || post.permalink || '';
  return {
    title: post.title || '',
    link: permalink,
    publishedAt: post.publishedAt || null,
    summary: post.summary || '',
    content: post.content || post.summary || post.title || '',
    subreddit: post.subreddit || fallbackSubreddit || null,
    score: typeof post.score === 'number' ? post.score : null,
    commentCount: typeof post.commentCount === 'number' ? post.commentCount : null,
  };
}

function parseJsonListing(body, fallbackSubreddit) {
  const children = body?.data?.children || [];
  return children
    .map((child) => child?.data)
    .filter(Boolean)
    .map((post) => normalizePost(post, fallbackSubreddit));
}

function tryParseJson(body) {
  if (!body) {
    return null;
  }

  if (typeof body === 'object') {
    return body;
  }

  if (typeof body !== 'string') {
    return null;
  }

  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function parse(input) {
  const subreddit = input.metadata?.subreddit || null;

  if (Array.isArray(input.body)) {
    return input.body
      .map((item) => normalizeBrowserPost(item, subreddit))
      .filter(Boolean);
  }

  const jsonBody = tryParseJson(input.body);

  if (jsonBody?.data?.children) {
    return parseJsonListing(jsonBody, subreddit);
  }

  const items = await rssPlugin.parse(input);
  return items.map((item) => ({
    ...item,
    subreddit,
    score: null,
    commentCount: null,
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueBrowserFetch(task) {
  const run = browserFetchQueue.then(task, task);
  browserFetchQueue = run.catch(() => undefined);
  return run;
}

async function waitForRedditRateLimit() {
  const now = Date.now();
  const waitMs = Math.max(0, REDDIT_REQUEST_INTERVAL_MS - (now - lastRedditRequestAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastRedditRequestAt = Date.now();
}

function getCredentials() {
  const username = process.env.REDDIT_USERNAME || process.env.REDDIT_USER || '';
  const password = process.env.REDDIT_PASSWORD || process.env.REDDIT_PASS || '';
  return { username, password };
}

function resolveUserAgent(candidate) {
  if (!candidate) {
    return DEFAULT_USER_AGENT;
  }

  const normalized = String(candidate).trim();
  if (!normalized || normalized === 'Mozilla/5.0' || normalized.length < 20) {
    return DEFAULT_USER_AGENT;
  }

  return normalized;
}

function getAuthStatePath() {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, '.reddit-auth.json');
}

async function createBrowserSession(headers = {}) {
  const { chromium } = require('playwright');
  const authStatePath = getAuthStatePath();
  const contextOptions = {
    userAgent: resolveUserAgent(headers['user-agent']),
    serviceWorkers: 'block',
  };

  if (fs.existsSync(authStatePath)) {
    contextOptions.storageState = authStatePath;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(contextOptions);

  return {
    browser,
    context,
    authStatePath,
    didLogin: false,
  };
}

async function newConfiguredPage(context, headers = {}) {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(30_000);
  page.setDefaultTimeout(30_000);

  if (headers && Object.keys(headers).length) {
    const filteredHeaders = Object.fromEntries(
      Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'user-agent')
    );

    if (Object.keys(filteredHeaders).length > 0) {
      await page.setExtraHTTPHeaders(filteredHeaders);
    }
  }

  return page;
}

async function loginIfNeeded(session, headers = {}) {
  const { username, password } = getCredentials();
  if (!username || !password || session.didLogin) {
    return;
  }

  const page = await newConfiguredPage(session.context, headers);
  try {
    await page.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded' });
    const usernameField = page.locator('input[name="username"], input#loginUsername').first();
    const passwordField = page.locator('input[name="password"], input#loginPassword').first();

    if (await usernameField.count() === 0 || await passwordField.count() === 0) {
      throw new Error('Reddit login page is unavailable on this network');
    }

    await usernameField.fill(username);
    await passwordField.fill(password);
    await page.locator('button[type="submit"]').last().click();
    await page.waitForURL((currentUrl) => !currentUrl.pathname.includes('/login'), { timeout: 20_000 }).catch(() => undefined);
    await session.context.storageState({ path: session.authStatePath });
    session.didLogin = true;
  } finally {
    await page.close().catch(() => undefined);
  }
}

function getListingUrl(url) {
  const target = new URL(url);
  if (target.pathname.endsWith('.json')) {
    target.pathname = target.pathname.replace(/\.json$/, '/');
    target.search = '';
  }
  return target.toString();
}

function getOldRedditListingUrl(url) {
  const target = new URL(url);
  const match = target.pathname.match(/^\/r\/([^/]+)/i);
  if (!match) {
    return getListingUrl(url);
  }

  return `https://old.reddit.com/r/${match[1]}/`;
}

async function fetchJsonThroughPage(session, url, headers = {}) {
  const page = await newConfiguredPage(session.context, headers);
  try {
    await page.goto(getListingUrl(url), { waitUntil: 'domcontentloaded' });
    return await page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, {
        credentials: 'include',
        headers: {
          accept: 'application/json,text/plain,*/*',
        },
      });

      return {
        status: response.status,
        body: await response.text(),
        contentType: response.headers.get('content-type') || '',
      };
    }, url);
  } finally {
    await page.close().catch(() => undefined);
  }
}

function isJsonListingResponse(result) {
  if (!result || result.status < 200 || result.status >= 300) {
    return false;
  }

  const parsed = tryParseJson(result.body);
  return Boolean(parsed?.data?.children);
}

async function scrapeListingWithBrowser(session, url, headers = {}) {
  const page = await newConfiguredPage(session.context, headers);
  try {
    await page.goto(getOldRedditListingUrl(url), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelectorAll('.thing').length > 0 || document.body.innerText.toLowerCase().includes('blocked by network security'),
      { timeout: 10_000 }
    ).catch(() => undefined);

    return await page.evaluate(() => {
      const parseNumber = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };

      const toAbsolute = (value) => {
        if (!value) {
          return '';
        }

        if (value.startsWith('http://') || value.startsWith('https://')) {
          return value;
        }

        return `https://www.reddit.com${value}`;
      };

      const parseCommentCount = (value) => {
        const match = String(value || '').match(/(\d+)/);
        return match ? Number(match[1]) : null;
      };

      return Array.from(document.querySelectorAll('.thing')).map((node) => {
        const titleLink = node.querySelector('.title.may-blank');
        const commentsLink = node.querySelector('a.comments');
        const timeNode = node.querySelector('time');
        const selfText = node.querySelector('.expando .usertext-body');
        const subredditLink = node.querySelector('.subreddit');
        const permalink = node.getAttribute('data-permalink') || commentsLink?.getAttribute('href') || '';
        const title = titleLink?.textContent?.trim() || '';
        const summary = selfText?.textContent?.trim() || '';

        return {
          title,
          link: toAbsolute(permalink),
          publishedAt: timeNode?.getAttribute('datetime') || null,
          summary,
          content: summary || title,
          subreddit: subredditLink?.textContent?.trim().replace(/^r\//i, '') || null,
          score: parseNumber(node.getAttribute('data-score')),
          commentCount: parseCommentCount(commentsLink?.textContent),
        };
      }).filter((item) => item.title && item.link);
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function fetchWithBrowser(url, headers = {}) {
  return enqueueBrowserFetch(async () => {
    await waitForRedditRateLimit();

    const session = await createBrowserSession(headers);
    try {
      let jsonResult = await fetchJsonThroughPage(session, url, headers);

      if (isJsonListingResponse(jsonResult)) {
        return jsonResult.body;
      }

      const listing = await scrapeListingWithBrowser(session, url, headers);
      if (listing.length > 0) {
        return listing;
      }

      if (jsonResult?.status === 401 || jsonResult?.status === 403) {
        await loginIfNeeded(session, headers).catch(() => undefined);
        jsonResult = await fetchJsonThroughPage(session, url, headers).catch(() => null);
        if (isJsonListingResponse(jsonResult)) {
          return jsonResult.body;
        }
      }

      throw new Error(`Reddit browser fetch returned no parseable items for ${url}`);
    } finally {
      await session.browser.close().catch(() => undefined);
    }
  });
}

module.exports = {
  parse,
  expandRequests: rssPlugin.expandRequests,
  fetchWithBrowser,
  // exported for unit tests and diagnostics
  REDDIT_REQUEST_INTERVAL_MS,
};