function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeUrl(candidate, options = {}) {
  if (!candidate) return null;
  const trimmed = decodeEntities(String(candidate).trim())
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .replace(/^['"]|['"]$/g, '');

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('/')) {
    const baseUrl = String(options.baseUrl || '').trim();
    if (baseUrl) {
      return new URL(trimmed, baseUrl).toString();
    }
  }

  return null;
}

function collectFromString(input, options = {}) {
  const text = String(input || '');
  const matches = [];
  const patterns = [
    /<loc>(https?:\/\/[^<]+)<\/loc>/gi,
    /<link>(https?:\/\/[^<]+)<\/link>/gi,
    /(?:"|')(?:url|href|seo|link|loc)(?:"|')\s*:\s*(?:"|')(https?:\/\/[^"']+)(?:"|')/gi,
    /(?:"|')(?:permalink)(?:"|')\s*:\s*(?:"|')([^"']+)(?:"|')/gi,
    /(https?:\/\/[^\s"'<>]+)/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      matches.push(match[1] || match[0]);
      match = pattern.exec(text);
    }
  }

  return matches
    .map((candidate) => normalizeUrl(candidate, options))
    .filter(Boolean);
}

function collectFromObject(input, options = {}, results = []) {
  if (input == null) {
    return results;
  }

  if (typeof input === 'string') {
    results.push(...collectFromString(input, options));
    return results;
  }

  if (Array.isArray(input)) {
    for (const value of input) {
      collectFromObject(value, options, results);
    }
    return results;
  }

  if (typeof input !== 'object') {
    return results;
  }

  const preferredKeys = ['link', 'loc', 'url', 'href', 'seo', 'permalink'];

  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const value = input[key];
      if (typeof value === 'string') {
        const normalized = normalizeUrl(value, options);
        if (normalized) {
          results.push(normalized);
        } else {
          results.push(...collectFromString(value, options));
        }
      } else {
        collectFromObject(value, options, results);
      }
    }
  }

  for (const [key, value] of Object.entries(input)) {
    if (preferredKeys.includes(key)) continue;
    collectFromObject(value, options, results);
  }

  return results;
}

function extractArticleLinks(input, options = {}) {
  let value = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        value = input;
      }
    }
  }

  const links = collectFromObject(value, options, []);
  return [...new Set(links.filter((link) => /^https?:\/\//i.test(link)))];
}

function extractPrimaryLink(input, options = {}) {
  const links = extractArticleLinks(input, options);
  return links[0] || '';
}

module.exports = {
  extractArticleLinks,
  extractPrimaryLink,
};