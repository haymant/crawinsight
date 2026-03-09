const { parseStringPromise } = require('xml2js');

function normalizeContextKey(key) {
  return key.endsWith('s') ? key.slice(0, -1) : key;
}

function buildExpansionContexts(params = {}) {
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
    link: item.link?.[0] || '',
    publishedAt: item.pubDate?.[0] || item['dc:date']?.[0] || null,
    summary: item.description?.[0] || '',
    content: item['content:encoded']?.[0] || item.description?.[0] || '',
  };
}

function normalizeSitemapItem(item) {
  const news = item['news:news']?.[0] || {};
  return {
    title: news['news:title']?.[0] || item.title?.[0] || '',
    link: item.loc?.[0] || '',
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

module.exports = {
  parse,
  expandRequests,
};