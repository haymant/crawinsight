function getLlmSentimentConfig() {
  const baseUrl = process.env.LLM_API_BASE_URL?.trim();
  const apiKey = process.env.LLM_API_KEY?.trim();
  const model = (process.env.LLM_SENTIMENT_MODEL || process.env.LLM_MODEL || '').trim();

  if (!baseUrl || !apiKey || !model) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    model,
  };
}

function extractJsonBlock(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return trimmed.slice(arrayStart, arrayEnd + 1);
  }

  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1);
  }

  return trimmed;
}

async function scoreMentionsWithLlm({ article, mentions }) {
  const config = getLlmSentimentConfig();
  if (!config || !Array.isArray(mentions) || !mentions.length) {
    return null;
  }

  const payload = mentions.map((mention, index) => ({
    mentionIndex: index,
    assetId: mention.assetId,
    contextSnippet: mention.contextSnippet,
  }));

  const prompt = [
    'Score each market mention on a continuous sentiment scale from -1 to 1.',
    'Return JSON only as an array of objects.',
    'Each object must contain: mentionIndex, score.',
    'Use negative values for bearish language, positive values for bullish language, and 0 for neutral.',
    `Article title: ${article.title || ''}`,
    `Article summary: ${article.summary || ''}`,
    `Mentions: ${JSON.stringify(payload)}`,
  ].join('\n');

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You are a financial sentiment classifier. Answer with strict JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM sentiment request failed with status ${response.status}`);
  }

  const result = await response.json();
  const content = result?.choices?.[0]?.message?.content;
  const jsonBlock = extractJsonBlock(content);
  if (!jsonBlock) {
    return null;
  }

  const parsed = JSON.parse(jsonBlock);
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.mentions)
      ? parsed.mentions
      : [];

  return rows
    .map((row) => ({
      mentionIndex: Number(row.mentionIndex),
      score: Number(row.score),
    }))
    .filter((row) => Number.isInteger(row.mentionIndex) && Number.isFinite(row.score));
}

module.exports = {
  getLlmSentimentConfig,
  scoreMentionsWithLlm,
};