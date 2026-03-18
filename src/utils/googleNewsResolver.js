const { extractArticleLinks } = require('./linkExtractor');

function isGoogleNewsUrl(candidate) {
  if (!candidate) return false;

  try {
    const parsed = new URL(candidate);
    return /(^|\.)news\.google\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function isLikelyPublisherUrl(candidate) {
  if (!candidate) return false;

  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (!/^https?:$/.test(parsed.protocol)) return false;
    if (isGoogleNewsUrl(candidate)) return false;
    if (/googleusercontent\.com$|gstatic\.com$|fonts\.googleapis\.com$|fonts\.gstatic\.com$|captcha-delivery\.com$/.test(hostname)) return false;
    if (/\.(png|jpe?g|gif|webp|svg|ico|js|css|woff2?|ttf|eot)$/i.test(pathname)) return false;
    if (/\b(css|font)\b/i.test(pathname) && hostname.endsWith('googleapis.com')) return false;

    return true;
  } catch {
    return false;
  }
}

function isGoogleNewsArticleUrl(candidate) {
  if (!isGoogleNewsUrl(candidate)) return false;

  try {
    const parsed = new URL(candidate);
    return /^\/rss\/articles\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function toAbsoluteUrl(candidate, baseUrl) {
  if (!candidate) return null;

  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractMetaRefreshTarget(body, baseUrl) {
  const match = String(body || '').match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>]+)["']/i);
  return toAbsoluteUrl(match?.[1] || null, baseUrl);
}

function extractCanonicalTarget(body, baseUrl) {
  const match = String(body || '').match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i);
  return toAbsoluteUrl(match?.[1] || null, baseUrl);
}

function resolveGoogleNewsPublisherUrl({ sourceUrl, resolvedUrl, body }) {
  const candidates = [
    resolvedUrl,
    extractMetaRefreshTarget(body, sourceUrl),
    extractCanonicalTarget(body, sourceUrl),
    ...extractArticleLinks(body, { baseUrl: sourceUrl }),
  ].filter(Boolean);

  return candidates.find((candidate) => isLikelyPublisherUrl(candidate)) || null;
}

module.exports = {
  isGoogleNewsUrl,
  isGoogleNewsArticleUrl,
  isLikelyPublisherUrl,
  resolveGoogleNewsPublisherUrl,
};