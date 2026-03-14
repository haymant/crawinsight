const vader = require('vader-sentiment');

const ASSET_STOP_WORDS = new Set([
  'A', 'AN', 'AND', 'ARE', 'AT', 'BE', 'BY', 'FOR', 'FROM', 'HAS', 'IN', 'IS', 'IT',
  'ITS', 'NOW', 'OF', 'ON', 'OR', 'THE', 'TO', 'US', 'USA', 'WITH', 'ETF', 'CEO', 'CFO'
]);

const POSITIVE_LLM_TERMS = [
  'beat', 'beats', 'bullish', 'strong', 'surge', 'raised', 'raise', 'upgrade', 'upgraded',
  'improved', 'growth', 'record', 'gain', 'upside', 'outperform', 'optimistic'
];

const NEGATIVE_LLM_TERMS = [
  'miss', 'missed', 'weak', 'cut', 'cuts', 'downgrade', 'downgraded', 'slump', 'decline',
  'drop', 'warning', 'bearish', 'lawsuit', 'shortfall', 'weakness', 'underperform'
];

const EARNINGS_KEYWORDS = ['earnings', 'revenue', 'margin', 'eps', 'profit', 'quarter'];
const GUIDANCE_KEYWORDS = ['guidance', 'outlook', 'forecast', 'target', 'estimate', 'delivery'];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeArticleText(article = {}) {
  return [article.title, article.summary, article.content].filter(Boolean).join(' ').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAssets(text = '') {
  const matches = text.match(/\$?[A-Z][A-Z0-9.:-]{1,9}\b/g) || [];
  return [...new Set(matches
    .map((match) => match.replace(/^\$/, '').replace(/[:.].*$/, ''))
    .filter((token) => /^[A-Z][A-Z0-9]{1,5}$/.test(token))
    .filter((token) => !ASSET_STOP_WORDS.has(token)))];
}

function classifySentiment(compound) {
  if (compound >= 0.05) {
    return 'positive';
  }
  if (compound <= -0.05) {
    return 'negative';
  }
  return 'neutral';
}

function estimateLlmScore(text = '') {
  const lower = text.toLowerCase();
  const positiveHits = POSITIVE_LLM_TERMS.filter((term) => lower.includes(term)).length;
  const negativeHits = NEGATIVE_LLM_TERMS.filter((term) => lower.includes(term)).length;

  if (positiveHits === 0 && negativeHits === 0) {
    return 0;
  }

  return clamp((positiveHits - negativeHits) / (positiveHits + negativeHits), -1, 1);
}

function extractContextSnippet(text, offset, width = 20) {
  const tokens = Array.from(text.matchAll(/\S+/g)).map((match) => ({ token: match[0], index: match.index }));
  if (!tokens.length) {
    return '';
  }

  const tokenIndex = tokens.findIndex(({ index, token }) => offset >= index && offset < index + token.length);
  const pivot = tokenIndex >= 0 ? tokenIndex : 0;
  const start = Math.max(0, pivot - width);
  const end = Math.min(tokens.length, pivot + width + 1);
  return tokens.slice(start, end).map(({ token }) => token).join(' ');
}

function extractMentionCandidates(article, options = {}) {
  const text = normalizeArticleText(article);
  if (!text) {
    return [];
  }

  const symbols = [...new Set([
    ...(Array.isArray(article.assets) ? article.assets : []),
    article.asset,
    ...extractAssets(text),
  ].filter(Boolean))];

  // If no asset symbols were detected, fall back to the source (or a generic "ALL") to
  // ensure we still generate daily features for the article.
  if (symbols.length === 0) {
    symbols.push(article.source || 'ALL');
  }

  const mentions = [];
  for (const symbol of symbols) {
    const regex = new RegExp(`\\$?${escapeRegExp(symbol)}\\b`, 'g');
    let match = regex.exec(text);

    while (match) {
      mentions.push({
        assetId: symbol,
        contextSnippet: extractContextSnippet(text, match.index, options.windowWords || 20),
        mentionOffset: match.index,
      });
      match = regex.exec(text);
    }

    if (!mentions.some((entry) => entry.assetId === symbol)) {
      mentions.push({
        assetId: symbol,
        contextSnippet: extractContextSnippet(text, 0, options.windowWords || 20),
        mentionOffset: 0,
      });
    }
  }

  return mentions;
}

function scoreMention(mention) {
  const vaderScore = vader.SentimentIntensityAnalyzer.polarity_scores(mention.contextSnippet || '');
  const llmScore = estimateLlmScore(mention.contextSnippet || '');
  const finalScore = average([vaderScore.compound, llmScore]);

  return {
    ...mention,
    vaderCompound: vaderScore.compound,
    llmScore,
    finalScore,
    sentimentType: classifySentiment(finalScore),
  };
}

function summarizeMentions(scoredMentions) {
  if (!scoredMentions.length) {
    return {
      sentiment: { compound: 0, pos: 0, neu: 1, neg: 0 },
      sentimentType: 'neutral',
      mentionCount: 0,
      llmScore: 0,
      finalScore: 0,
    };
  }

  const vaderMean = average(scoredMentions.map((mention) => mention.vaderCompound));
  const llmMean = average(scoredMentions.map((mention) => mention.llmScore));
  const finalScore = average(scoredMentions.map((mention) => mention.finalScore));
  return {
    sentiment: {
      compound: finalScore,
      vaderCompound: vaderMean,
      llmScore: llmMean,
      mentionCount: scoredMentions.length,
    },
    sentimentType: classifySentiment(finalScore),
    mentionCount: scoredMentions.length,
    llmScore: llmMean,
    finalScore,
  };
}

function analyzeMentions(article, options = {}) {
  return extractMentionCandidates(article, options).map(scoreMention);
}

function buildDailyFeatureRows(mentions, previousRows = []) {
  const previousBySymbol = new Map();
  for (const row of previousRows) {
    const entries = previousBySymbol.get(row.symbol) || [];
    entries.push(row);
    previousBySymbol.set(row.symbol, entries);
  }

  const grouped = new Map();
  for (const mention of mentions) {
    const date = new Date(mention.publishedAt || mention.createdAt || Date.now());
    const featureDate = `${date.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const key = JSON.stringify([featureDate, mention.assetId]);
    const rows = grouped.get(key) || [];
    rows.push(mention);
    grouped.set(key, rows);
  }

  return Array.from(grouped.entries()).map(([key, rows]) => {
    const [featureDate, symbol] = JSON.parse(key);
    const articleIds = [...new Set(rows.map((row) => row.articleId))];
    const snippets = rows.map((row) => String(row.contextSnippet || '').toLowerCase());
    const currentMean = average(rows.map((row) => row.finalScore));
    const history = (previousBySymbol.get(symbol) || []).sort((left, right) => String(left.featureDate).localeCompare(String(right.featureDate)));
    const latest = history.length ? history[history.length - 1] : null;
    const volatilityWindow = [...history.slice(-6).map((row) => Number(row.vaderMean || 0)), currentMean];
    const volatilityMean = average(volatilityWindow);
    const variance = volatilityWindow.length
      ? average(volatilityWindow.map((value) => (value - volatilityMean) ** 2))
      : 0;

    return {
      featureDate,
      symbol,
      articleCount: articleIds.length,
      vaderMean: average(rows.map((row) => row.vaderCompound)),
      llmMean: average(rows.map((row) => row.llmScore)),
      mentionDensity: rows.length / Math.max(articleIds.length, 1),
      positiveRatio: rows.filter((row) => row.finalScore >= 0.05).length / rows.length,
      earningsKeywordScore: snippets.filter((snippet) => EARNINGS_KEYWORDS.some((term) => snippet.includes(term))).length / rows.length,
      guidanceKeywordScore: snippets.filter((snippet) => GUIDANCE_KEYWORDS.some((term) => snippet.includes(term))).length / rows.length,
      sentimentMomentum1d: currentMean - Number(latest?.vaderMean || 0),
      sentimentVolatility7d: Math.sqrt(variance),
    };
  });
}

function analyzeArticle(article, { sourceName, filters = {} }) {
  const text = normalizeArticleText(article);
  const scores = vader.SentimentIntensityAnalyzer.polarity_scores(text);
  const extractedAssets = [...new Set([
    ...extractAssets(text),
    ...(Array.isArray(article.assets) ? article.assets : []),
    article.asset,
  ].filter(Boolean))];

  const keywords = filters.keywords || [];
  const lowerText = text.toLowerCase();
  const keywordMatch = keywords.length === 0 || keywords.some((keyword) => lowerText.includes(keyword.toLowerCase()));
  const assetMatch = extractedAssets.length > 0;

  return {
    ...article,
    source: sourceName,
    sentiment: scores,
    sentimentType: classifySentiment(scores.compound),
    assets: extractedAssets,
    isRelevant: keywordMatch || assetMatch,
    ingestedAt: new Date().toISOString(),
  };
}

module.exports = {
  analyzeArticle,
  analyzeMentions,
  buildDailyFeatureRows,
  classifySentiment,
  estimateLlmScore,
  extractAssets,
  extractMentionCandidates,
  summarizeMentions,
};