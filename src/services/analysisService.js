const vader = require('vader-sentiment');

const ASSET_STOP_WORDS = new Set([
  'A', 'AN', 'AND', 'ARE', 'AT', 'BE', 'BY', 'FOR', 'FROM', 'HAS', 'IN', 'IS', 'IT',
  'ITS', 'NOW', 'OF', 'ON', 'OR', 'THE', 'TO', 'US', 'USA', 'WITH'
]);

function extractAssets(text = '') {
  const matches = text.match(/\$?[A-Z]{2,5}\b/g) || [];
  return [...new Set(matches
    .map((match) => match.replace('$', ''))
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

function analyzeArticle(article, { sourceName, filters = {} }) {
  const text = [article.title, article.content, article.summary].filter(Boolean).join(' ');
  const scores = vader.SentimentIntensityAnalyzer.polarity_scores(text);
  const extractedAssets = extractAssets(text);
  if (article.asset && !extractedAssets.includes(article.asset)) {
    extractedAssets.push(article.asset);
  }

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
  extractAssets,
  classifySentiment,
};