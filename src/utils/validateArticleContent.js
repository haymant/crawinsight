const BLOCK_PHRASES = [
  'captcha',
  'cloudflare',
  'verify you are human',
  'access denied',
  'redirecting',
  'blocked',
  'human verification',
  'please wait while we verify',
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it',
  'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was', 'were', 'will', 'with', 'after',
  'before', 'amid', 'over', 'under', 'says', 'say', 'said', 'reuters', 'news', 'update', 'exclusive', 'analysis',
]);

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(html) {
  return decodeEntities(String(html || ''))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMetaContent(html, propertyName) {
  const match = String(html || '').match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${propertyName}["'][^>]+content=["']([^"']+)["']`, 'i')
  );
  return decodeEntities(match?.[1] || '').trim();
}

function extractTagText(html, tagName) {
  const match = String(html || '').match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\/${tagName}>`, 'i'));
  return stripHtml(match?.[1] || '');
}

function normalizeTitle(title) {
  return String(title || '')
    .replace(/\s*[|:-]\s*(reuters|seeking alpha|bloomberg|cnbc|new york times|nyt)$/i, '')
    .replace(/['’]/g, '')
    .trim();
}

function tokenize(text) {
  const tokens = String(text || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  return [...new Set(tokens.filter((token) => !STOP_WORDS.has(token)))];
}

function countWordMatches(text, keywords) {
  const haystack = ` ${String(text || '').toLowerCase()} `;
  return keywords.filter((keyword) => haystack.includes(` ${keyword.toLowerCase()} `)).length;
}

function computeTitleSimilarity(left, right) {
  const leftTokens = tokenize(normalizeTitle(left));
  const rightTokens = tokenize(normalizeTitle(right));

  if (!leftTokens.length || !rightTokens.length) {
    return 0;
  }

  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  return overlap / Math.max(leftTokens.length, rightTokens.length);
}

function extractKeywordCandidates(articleTitle, articleSummary) {
  const ranked = tokenize(`${articleTitle || ''} ${articleSummary || ''}`);
  return ranked.slice(0, 8);
}

function extractContentSignals(html, cleanedText) {
  const rawHtml = String(html || '');
  const paragraphCount = (rawHtml.match(/<p\b/gi) || []).length;
  const hasArticleTag = /<article\b/i.test(rawHtml);
  const wordCount = (String(cleanedText || '').match(/\S+/g) || []).length;

  return {
    paragraphCount,
    hasArticleTag,
    wordCount,
    hasArticleMarkers: hasArticleTag || paragraphCount >= 3 || wordCount >= 500,
  };
}

function validateArticleContent({
  body,
  contentType,
  parentTitle,
  parentSummary,
  minBodyLength = 400,
  minTitleSimilarity = 0.75,
  minKeywordMatches = 3,
} = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body || '');
  const isHtml = /html/i.test(String(contentType || '')) || /<html|<article|<body/i.test(rawBody);
  const cleanedText = isHtml ? stripHtml(rawBody) : decodeEntities(rawBody).replace(/\s+/g, ' ').trim();
  const pageTitle = normalizeTitle(
    extractMetaContent(rawBody, 'og:title') ||
    extractMetaContent(rawBody, 'twitter:title') ||
    extractTagText(rawBody, 'title') ||
    extractTagText(rawBody, 'h1')
  );
  const sourceTitle = normalizeTitle(parentTitle);
  const titleSimilarity = computeTitleSimilarity(pageTitle, sourceTitle);
  const keywordCandidates = extractKeywordCandidates(parentTitle, parentSummary);
  const requiredKeywordMatches = Math.min(minKeywordMatches, keywordCandidates.length);
  const keywordMatches = countWordMatches(cleanedText, keywordCandidates);
  const signals = extractContentSignals(rawBody, cleanedText);
  const combinedLower = `${rawBody}\n${cleanedText}`.toLowerCase();
  const blockPhrase = BLOCK_PHRASES.find((phrase) => combinedLower.includes(phrase));

  if (blockPhrase) {
    return {
      isValid: false,
      reason: 'blocked-page',
      excerpt: cleanedText.slice(0, 200),
      cleanedContent: cleanedText,
      titleSimilarity,
      keywordMatches,
      keywordCandidates,
      pageTitle,
      blockPhrase,
      signals,
    };
  }

  if (cleanedText.length <= minBodyLength) {
    return {
      isValid: false,
      reason: 'short-body',
      excerpt: cleanedText.slice(0, 200),
      cleanedContent: cleanedText,
      titleSimilarity,
      keywordMatches,
      keywordCandidates,
      pageTitle,
      signals,
    };
  }

  if (titleSimilarity < minTitleSimilarity) {
    return {
      isValid: false,
      reason: 'title-mismatch',
      excerpt: cleanedText.slice(0, 200),
      cleanedContent: cleanedText,
      titleSimilarity,
      keywordMatches,
      keywordCandidates,
      pageTitle,
      signals,
    };
  }

  if (requiredKeywordMatches > 0 && keywordMatches < requiredKeywordMatches) {
    return {
      isValid: false,
      reason: 'keyword-miss',
      excerpt: cleanedText.slice(0, 200),
      cleanedContent: cleanedText,
      titleSimilarity,
      keywordMatches,
      keywordCandidates,
      pageTitle,
      signals,
    };
  }

  if (!signals.hasArticleMarkers) {
    return {
      isValid: false,
      reason: 'article-marker-miss',
      excerpt: cleanedText.slice(0, 200),
      cleanedContent: cleanedText,
      titleSimilarity,
      keywordMatches,
      keywordCandidates,
      pageTitle,
      signals,
    };
  }

  return {
    isValid: true,
    reason: 'valid',
    excerpt: cleanedText.slice(0, 200),
    cleanedContent: cleanedText,
    titleSimilarity,
    keywordMatches,
    keywordCandidates,
    pageTitle,
    signals,
  };
}

module.exports = {
  BLOCK_PHRASES,
  stripHtml,
  validateArticleContent,
};