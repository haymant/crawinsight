const fs = require('fs');
const path = require('path');
const rssPlugin = require('./rss');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 CrawlInsight/1.0';
const MAX_REQS = Number(process.env.MAX_REQUESTS_PER_SOURCE_MINUTE) || 5;
const X_REQUEST_INTERVAL_MS = Math.ceil(60000 / MAX_REQS);

let browserFetchQueue = Promise.resolve();
let lastXRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueBrowserFetch(task) {
  const run = browserFetchQueue.then(task, task);
  browserFetchQueue = run.catch(() => undefined);
  return run;
}

async function waitForXRateLimit() {
  const now = Date.now();
  const waitMs = Math.max(0, X_REQUEST_INTERVAL_MS - (now - lastXRequestAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastXRequestAt = Date.now();
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

function getCredentials() {
  return {
    username: process.env.X_USERNAME || '',
    password: process.env.X_PASSWORD || '',
  };
}

function getAuthStatePath() {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, '.x-auth.json');
}

function extractListId(url) {
  const match = String(url || '').match(/\/i\/lists\/(\d+)/i);
  return match ? match[1] : null;
}

function buildMetadata(url, metadata = {}) {
  const listId = metadata.listId || extractListId(url);
  return listId ? { ...metadata, listId } : metadata;
}

function expandRequests(source) {
  return rssPlugin.expandRequests(source).map((request) => ({
    ...request,
    metadata: buildMetadata(request.url, request.metadata),
  }));
}

function normalizePost(post, metadata = {}) {
  if (!post || typeof post !== 'object') {
    return null;
  }

  const content = String(post.content || post.summary || post.title || '').trim();
  const handle = post.handle ? String(post.handle).replace(/^@/, '') : (metadata.handle || null);
  const title = String(post.title || content.slice(0, 120) || '').trim();

  return {
    title,
    link: post.link || '',
    publishedAt: post.publishedAt || null,
    summary: post.summary || content,
    content,
    author: post.author || metadata.author || null,
    handle,
    listId: post.listId || metadata.listId || null,
    account: post.account || metadata.account || null,
    tag: post.tag || metadata.tag || null,
    likeCount: typeof post.likeCount === 'number' ? post.likeCount : null,
    repostCount: typeof post.repostCount === 'number' ? post.repostCount : null,
    replyCount: typeof post.replyCount === 'number' ? post.replyCount : null,
  };
}

async function parse({ body, metadata = {} }) {
  if (!Array.isArray(body)) {
    throw new Error('X plugin expects browser-extracted items');
  }

  return body
    .map((item) => normalizePost(item, buildMetadata(item.link, metadata)))
    .filter(Boolean);
}

// determine headless mode once so both session creation and login
// logic see the same value.  `X_HEADLESS=false` makes HEADLESS false.
const HEADLESS = process.env.X_HEADLESS !== 'false';

async function createBrowserSession(headers = {}) {
  const { chromium } = require('playwright');
  const authStatePath = getAuthStatePath();
  const contextOptions = {
    userAgent: resolveUserAgent(headers['user-agent']),
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 1200 },
  };

  if (fs.existsSync(authStatePath)) {
    contextOptions.storageState = authStatePath;
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext(contextOptions);

  return {
    browser,
    context,
    authStatePath,
  };
}

async function newConfiguredPage(context, headers = {}) {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(45_000);
  page.setDefaultTimeout(45_000);

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

async function isLoggedIn(page) {
  if (page.url().includes('/i/flow/login')) {
    return false;
  }

  const markers = [
    '[data-testid="SideNav_NewTweet_Button"]',
    'a[href="/home"]',
    '[aria-label="Home timeline"]',
  ];

  for (const selector of markers) {
    if (await page.locator(selector).count().catch(() => 0)) {
      return true;
    }
  }

  return false;
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      await locator.click();
      return true;
    }
  }

  return false;
}

async function loginIfNeeded(session, headers = {}) {
  const { username, password } = getCredentials();
  if (!username || !password) {
    throw new Error('X_USERNAME and X_PASSWORD are required for X browser fetches');
  }

  const page = await newConfiguredPage(session.context, headers);
  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    if (await isLoggedIn(page)) {
      return;
    }

// navigate then wait for the actual login inputs to render; X injects them asynchronously
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' });
  const loginInputSelector = 'input[name="text"], input[name="session[username_or_email]"], input[type="email"], input[autocomplete="username"]';
  await page.waitForSelector(loginInputSelector, { timeout: 15000 }).catch(() => {
      throw new Error('X login page is unavailable on this network');
  });

  const usernameField = page.locator(loginInputSelector).first();
    await usernameField.fill(username);
    await clickFirstVisible(page, [
      'button:has-text("Next")',
      'div[role="button"]:has-text("Next")',
      'button:has-text("Log in")',
      'div[role="button"]:has-text("Log in")',
    ]);

    // after submitting username we may land on a phone/username challenge
    // before the password field appears. loop until we see the password box or
    // give up. only auto-fill the first challenge (typically phone); any
    // additional prompt will pause or fail.
    const passwordSelector = 'input[name="password"]';
    const challengeSelector = 'input[data-testid="ocfEnterTextTextInput"], input[name="text"], input[type="tel"]';
    let challengeHandled = false;

    for (let attempt = 0; attempt < 6; attempt++) {
      // wait for something useful to appear
      await Promise.race([
        page.waitForSelector(passwordSelector, { timeout: 8000 }).catch(() => null),
        page.waitForSelector(challengeSelector, { timeout: 8000 }).catch(() => null),
      ]);

      if (await page.locator(passwordSelector).count()) {
        // ready for password
        break;
      }

      if (await page.locator(challengeSelector).count()) {
        // some sort of extra prompt
        if (!challengeHandled) {
          // treat first prompt as phone/username entry
          await page.locator(challengeSelector).first().fill(username);
          await clickFirstVisible(page, [
            'button:has-text("Next")',
            'div[role="button"]:has-text("Next")',
          ]);
          challengeHandled = true;
          continue;
        }
        // second or later challenge, hand off to user or fail
        if (!HEADLESS) {
          console.log('X plugin: additional login challenge, pausing for manual input');
          await page.pause();
          if (await page.locator(passwordSelector).count()) {
            break;
          }
        }
        throw new Error('X login challenge requires manual verification');
      }

      // nothing appeared; if interactive, let user handle it
      if (!HEADLESS) {
        console.log('X plugin: awaiting manual login challenge resolution');
        await page.pause();
        if (await page.locator(passwordSelector).count()) {
          break;
        }
      }
    }

    const readyPasswordField = page.locator(passwordSelector).first();
    if (await readyPasswordField.count() === 0) {
      throw new Error('X login challenge requires manual verification');
    }

    await readyPasswordField.fill(password);
    await clickFirstVisible(page, [
      'button:has-text("Log in")',
      'div[role="button"]:has-text("Log in")',
    ]);

    await page.waitForFunction(() => !location.href.includes('/i/flow/login'), { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);

    if (page.url().includes('/i/flow/login')) {
      throw new Error('X authentication did not complete successfully');
    }

    await session.context.storageState({ path: session.authStatePath });
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function ensureAuthenticated(session, headers = {}) {
  try {
    await loginIfNeeded(session, headers);
  } catch (error) {
    throw new Error(`X authentication failed: ${error.message}`);
  }
}

async function extractTimeline(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelectorAll('article[data-testid="tweet"]').length > 0 || location.href.includes('/i/flow/login'),
    { timeout: 20_000 }
  ).catch(() => undefined);

  if (page.url().includes('/i/flow/login')) {
    throw new Error('X redirected the session back to login');
  }

  for (let index = 0; index < 3; index += 1) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
    await page.waitForTimeout(1_000);
  }

  return page.evaluate((currentUrl) => {
    const currentListMatch = String(currentUrl || '').match(/\/i\/lists\/(\d+)/i);
    const currentListId = currentListMatch ? currentListMatch[1] : null;

    const parseMetric = (value) => {
      const normalized = String(value || '').trim().replace(/,/g, '').toUpperCase();
      const match = normalized.match(/([\d.]+)\s*([KMB])?/);
      if (!match) {
        return null;
      }

      const base = Number(match[1]);
      if (!Number.isFinite(base)) {
        return null;
      }

      const multipliers = { K: 1000, M: 1000000, B: 1000000000 };
      return Math.round(base * (multipliers[match[2]] || 1));
    };

    const readMetric = (node, testId) => {
      const button = node.querySelector(`[data-testid="${testId}"]`);
      if (!button) {
        return null;
      }

      const aria = button.getAttribute('aria-label') || '';
      const fromAria = parseMetric(aria);
      if (fromAria !== null) {
        return fromAria;
      }

      return parseMetric(button.textContent || '');
    };

    return Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map((node) => {
      const linkNode = Array.from(node.querySelectorAll('a[href*="/status/"]')).find((anchor) => anchor.href.includes('/status/'));
      if (!linkNode) {
        return null;
      }

      const link = linkNode.href.split('?')[0];
      const handleMatch = link.match(/x\.com\/([^/]+)\/status\//i);
      const tweetText = node.querySelector('[data-testid="tweetText"]');
      const timeNode = node.querySelector('time');
      const userNameNodes = node.querySelectorAll('[data-testid="User-Name"] span');
      const author = userNameNodes[0]?.textContent?.trim() || null;
      const content = tweetText?.textContent?.trim() || '';

      return {
        title: content.slice(0, 120) || author || link,
        link,
        publishedAt: timeNode?.getAttribute('datetime') || null,
        summary: content,
        content,
        author,
        handle: handleMatch ? handleMatch[1] : null,
        listId: currentListId,
        likeCount: readMetric(node, 'like'),
        repostCount: readMetric(node, 'retweet'),
        replyCount: readMetric(node, 'reply'),
      };
    }).filter((item) => item && item.link && item.content);
  }, url);
}

async function fetchWithBrowser(url, headers = {}) {
  return enqueueBrowserFetch(async () => {
    await waitForXRateLimit();

    const session = await createBrowserSession(headers);
    try {
      await ensureAuthenticated(session, headers);

      const page = await newConfiguredPage(session.context, headers);
      try {
        const items = await extractTimeline(page, url);
        if (items.length === 0) {
          throw new Error(`X browser fetch returned no parseable items for ${url}`);
        }
        return items;
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await session.browser.close().catch(() => undefined);
    }
  });
}

module.exports = {
  parse,
  expandRequests,
  fetchWithBrowser,
  X_REQUEST_INTERVAL_MS,
  extractListId,
};