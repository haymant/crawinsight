const DEFAULT_RELEVANCE_KEYWORDS = ['oil', 'hormuz', 'iran', 'tanker', 'reinsurance', 'palantir', 'guidance', 'earnings'];

class DepthController {
  evaluate({ article, source, maxCrawlDepth }) {
    const currentDepth = Number(article?.crawlDepth || 1);
    if (!Number.isFinite(maxCrawlDepth) || maxCrawlDepth <= currentDepth) {
      return { allowed: false, reason: 'max-depth', keywordsMatched: [] };
    }

    if (!article?.link) {
      return { allowed: false, reason: 'no-link', keywordsMatched: [] };
    }

    const configuredKeywords = source?.options?.relevanceKeywords;
    const keywords = Array.isArray(configuredKeywords) && configuredKeywords.length > 0
      ? configuredKeywords
      : null;

    if (!keywords) {
      return { allowed: true, reason: 'allowed', keywordsMatched: [] };
    }

    const haystack = [article.title, article.summary, article.content]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const keywordsMatched = keywords.filter((keyword) => haystack.includes(String(keyword).toLowerCase()));

    if (keywordsMatched.length > 0) {
      return { allowed: true, reason: 'allowed', keywordsMatched };
    }

    const fallbackMatches = DEFAULT_RELEVANCE_KEYWORDS.filter((keyword) => haystack.includes(keyword));
    if (configuredKeywords == null && fallbackMatches.length > 0) {
      return { allowed: true, reason: 'allowed', keywordsMatched: fallbackMatches };
    }

    return { allowed: false, reason: 'keyword-miss', keywordsMatched: [] };
  }
}

module.exports = { DepthController, DEFAULT_RELEVANCE_KEYWORDS };