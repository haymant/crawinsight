const { parseStringPromise } = require('xml2js');
const { extractPrimaryLink } = require('../utils/linkExtractor');

function resolveBrowserLaunchOptions() {
  const launchOptions = {
    headless: process.env.RSS_HEADLESS !== 'false',
    args: ['--disable-blink-features=AutomationControlled'],
  };

  const preferredChannel = process.env.RSS_BROWSER_CHANNEL || 'chrome';
  if (preferredChannel) {
    launchOptions.channel = preferredChannel;
  }

  return launchOptions;
}

async function applyBrowserStealth(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });

    window.chrome = window.chrome || { runtime: {} };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanizePageInteraction(page) {
  const viewport = page.viewportSize() || { width: 1366, height: 900 };
  const rand = (min, max) => min + Math.random() * (max - min);
  const steps = 4 + Math.floor(Math.random() * 4);

  for (let i = 0; i < steps; i += 1) {
    const x = rand(50, viewport.width - 50);
    const y = rand(50, viewport.height - 50);
    await page.mouse.move(x, y, { steps: 3 + Math.floor(Math.random() * 4) });
    await sleep(rand(120, 320));
  }

  // Slight scrolls to mimic reading behavior
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.4));
  await sleep(rand(300, 600));
  await page.evaluate(() => window.scrollBy(0, -window.innerHeight * 0.2));
  await sleep(rand(200, 500));
}

function normalizeContextKey(key) {
  return key.endsWith('s') ? key.slice(0, -1) : key;
}

function buildExpansionContexts(params) {
  // params may be null (saved from DB); coerce to object
  params = params || {};
  const keys = Object.keys(params);
  if (keys.length === 0) {
    return [{}];
  }

  const contexts = [{}];

  for (const key of keys) {
    const values = Array.isArray(params[key]) ? params[key] : [params[key]];
    const normalizedKey = normalizeContextKey(key);
    const nextContexts = [];

    for (const context of contexts) {
      for (const value of values) {
        nextContexts.push({
          ...context,
          [key]: value,
          [normalizedKey]: value,
        });
      }
    }

    contexts.splice(0, contexts.length, ...nextContexts);
  }

  return contexts;
}

function applyTemplate(url, context) {
  return Object.entries(context).reduce((accumulator, [key, value]) => {
    return accumulator.replaceAll(`{${key}}`, value);
  }, url);
}

async function parseFeed(xml) {
  return parseStringPromise(xml, { explicitArray: true, trim: true });
}

function normalizeRssItem(item) {
  return {
    title: item.title?.[0] || '',
    link: item.link?.[0] || extractPrimaryLink(item),
    publishedAt: item.pubDate?.[0] || item['dc:date']?.[0] || null,
    summary: item.description?.[0] || '',
    content: item['content:encoded']?.[0] || item.description?.[0] || '',
  };
}

function normalizeSitemapItem(item) {
  const news = item['news:news']?.[0] || {};
  return {
    title: news['news:title']?.[0] || item.title?.[0] || '',
    link: item.loc?.[0] || extractPrimaryLink(item),
    publishedAt: news['news:publication_date']?.[0] || null,
    summary: '',
    content: news['news:title']?.[0] || item.title?.[0] || '',
  };
}

async function parse({ body }) {
  const parsed = await parseFeed(body);
  const rssItems = parsed?.rss?.channel?.[0]?.item || [];
  if (rssItems.length > 0) {
    return rssItems.map(normalizeRssItem);
  }

  const sitemapItems = parsed?.urlset?.url || [];
  return sitemapItems.map(normalizeSitemapItem);
}

function expandRequests(source) {
  const contexts = buildExpansionContexts(source.params);
  const requests = [];

  for (const url of source.urls) {
    for (const context of contexts) {
      requests.push({
        url: applyTemplate(url, context),
        metadata: context,
      });
    }
  }

  return requests;
}

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

async function fetchLinkedArticleWithBrowser(url, headers = {}, sessionState) {
  const browser = await chromium.launch(resolveBrowserLaunchOptions());
  const context = await browser.newContext({
    userAgent:
      headers['user-agent'] ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
    locale: 'en-US',
  });
  await applyBrowserStealth(context);

  if (sessionState && Array.isArray(sessionState.cookies) && sessionState.cookies.length) {
    const normalizedCookies = sessionState.cookies.map((cookie) => ({
      ...cookie,
      value: typeof cookie.value === 'string' ? cookie.value : String(cookie.value),
    }));
    await context.addCookies(normalizedCookies).catch(() => undefined);
  }

  const page = await context.newPage();

  if (sessionState && (sessionState.localStorage || sessionState.sessionStorage)) {
    await page.addInitScript((local, session) => {
      if (local && typeof local === 'object') {
        Object.entries(local).forEach(([key, value]) => {
          localStorage.setItem(key, String(value));
        });
      }
      if (session && typeof session === 'object') {
        Object.entries(session).forEach(([key, value]) => {
          sessionStorage.setItem(key, String(value));
        });
      }
    }, sessionState.localStorage, sessionState.sessionStorage);
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);

    const shouldHumanize = process.env.RSS_HUMANIZE === 'true' || process.env.RSS_HEADLESS === 'false';
    if (shouldHumanize) {
      await humanizePageInteraction(page);
    }

    if (/^https?:\/\/news\.google\.com\//i.test(url)) {
      await page.waitForFunction(() => !window.location.hostname.includes('news.google.com'), undefined, { timeout: 10_000 }).catch(() => undefined);
    }

    // For Seeking Alpha we prefer the main article text to avoid capturing full HTML / JSON-LD.
    // Other feeds may not have an <article> wrapper that contains the full story.
    const isSeekingAlpha = /^https?:\/\/(www\.)?seekingalpha\.com\//i.test(url);
    const body = isSeekingAlpha
      ? await page.$eval('article.container, article', (article) => {
          const clone = article.cloneNode(true);
          clone.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
          return clone.innerText?.trim() || '';
        }).catch(async () => {
          // Fallback to full HTML if article container isn't present
          return await page.content();
        })
      : await page.content();

    const resolvedUrl = page.url();

    // When Google detects “unusual activity” it serves a challenge page.
    // If the env var is enabled, pause here so a human can solve the captcha.
    const isChallenge = /(?:unusual activity|verify your device|access is temporarily restricted)/i.test(body)
    const allowChallengePause = process.env.RSS_ALLOW_CHALLENGE_INTERVENTION === 'true'

    if (isChallenge && allowChallengePause && process.env.RSS_HEADLESS === 'false') {
      console.log('RSS plugin: challenge detected — pausing for manual intervention. Press Enter to continue...')
      // pause() works in Playwright and gives a UI, but as a fallback allow stdin.
      await (page.pause ? page.pause() : Promise.resolve())
      await new Promise((resolve) => {
        process.stdin.resume()
        process.stdin.once('data', () => {
          process.stdin.pause()
          resolve(undefined)
        })
      })
    }

    // Throttle between site calls to avoid hitting rate limits (e.g. Seeking Alpha).
    const delayMs = 5000 + Math.floor(Math.random() * 5000) // 5–10s
    await sleep(delayMs)

    return {
      body,
      contentType: 'text/html; charset=utf-8',
      resolvedUrl,
    }
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

module.exports = {
  parse,
  expandRequests,
  fetchLinkedArticleWithBrowser,
};
