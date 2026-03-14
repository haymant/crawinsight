const crypto = require('crypto');
const {
  analyzeMentions,
  buildDailyFeatureRows,
  classifySentiment,
  summarizeMentions,
} = require('./analysisService');
const { scoreMentionsWithLlm } = require('./llmSentimentService');

class SentimentService {
  constructor({ articleRepository, mentionRepository, featureRepository, jobService, queueService }) {
    this.articleRepository = articleRepository;
    this.mentionRepository = mentionRepository;
    this.featureRepository = featureRepository;
    this.jobService = jobService;
    this.queueService = queueService;
  }

  async requestAnalysis({ source, articleIds, parentJobId = null, forceInline = false }) {
    const job = await this.jobService.createJob('sentiment-judge', { source, articleIds, parentJobId });

    if (this.queueService?.isEnabled() && !forceInline) {
      const queueId = await this.queueService.publishSentimentJob({ jobId: job.id, source, articleIds, parentJobId });
      await this.jobService.updateJob(job.id, { status: 'queued', queueId: queueId || null });
      return { jobId: job.id, queueId: queueId || null, status: 'queued' };
    }

    const result = await this.processAnalysisJob(job.id, { source, articleIds, parentJobId }, { queueId: null });
    return { jobId: job.id, queueId: null, status: result.status, ...result };
  }

  async processQueuedJob(job) {
    const payload = job?.data || {};
    if (!payload.jobId) {
      return null;
    }

    return this.processAnalysisJob(payload.jobId, payload, { queueId: job.id || null });
  }

  async processAnalysisJob(jobId, payload, metadata = {}) {
    await this.jobService.updateJob(jobId, {
      status: 'running',
      queueId: metadata.queueId || null,
      startedAt: new Date().toISOString(),
    });

    try {
      const articleIds = Array.isArray(payload.articleIds) ? payload.articleIds : [];
      const articles = articleIds.length
        ? await this.articleRepository.getByIds(articleIds)
        : await this.articleRepository.query({ source: payload.source });

      const mentions = [];
      for (const article of articles) {
        const articleId = article.id || article.articleId || article.article_id;
        const scoredMentions = analyzeMentions(article).map((mention) => ({
          mentionId: crypto.createHash('sha256').update(`${articleId}:${mention.assetId}:${mention.mentionOffset}`).digest('hex'),
          articleId,
          source: article.source || payload.source || null,
          assetId: mention.assetId,
          contextSnippet: mention.contextSnippet,
          vaderCompound: mention.vaderCompound,
          llmScore: mention.llmScore,
          finalScore: mention.finalScore,
          sentimentType: mention.sentimentType,
          mentionOffset: mention.mentionOffset,
          publishedAt: article.publishedAt || article.published_at || article.ingestedAt || article.ingested_at || null,
          createdAt: new Date().toISOString(),
        }));
        try {
          const llmScores = await scoreMentionsWithLlm({ article, mentions: scoredMentions });
          if (Array.isArray(llmScores) && llmScores.length) {
            for (const row of llmScores) {
              const mention = scoredMentions[row.mentionIndex];
              if (!mention) {
                continue;
              }
              mention.llmScore = row.score;
              mention.finalScore = (Number(mention.vaderCompound || 0) + row.score) / 2;
              mention.sentimentType = classifySentiment(mention.finalScore);
            }
          }
        } catch (error) {
          console.warn('llm sentiment scoring failed, falling back to heuristic scores:', error.message);
        }
        const summary = summarizeMentions(scoredMentions);
        await this.articleRepository.updateAnalysis(articleId, {
          sentiment: summary.sentiment,
          sentimentType: summary.sentimentType,
          metadata: {
            mentionCount: summary.mentionCount,
            llmScore: summary.llmScore,
            finalScore: summary.finalScore,
          },
        });
        mentions.push(...scoredMentions);
      }

      await this.mentionRepository.replaceForArticles(
        articles.map((article) => article.id || article.articleId || article.article_id),
        mentions
      );
      const recentRows = await this.featureRepository.getRecentBySymbols([...new Set(mentions.map((mention) => mention.assetId))]);
      const featureRows = buildDailyFeatureRows(mentions, recentRows);
      await this.featureRepository.upsertMany(featureRows);

      console.log(
        `[Sentiment] upserted ${featureRows.length} feature rows for ${payload.source || 'unknown'} (articles=${articles.length}, mentions=${mentions.length})`
      );

      const result = {
        source: payload.source || null,
        articleCount: articles.length,
        mentionCount: mentions.length,
        featureCount: featureRows.length,
        symbols: [...new Set(mentions.map((mention) => mention.assetId))],
      };

      await this.jobService.updateJob(jobId, {
        status: 'completed',
        result,
        finishedAt: new Date().toISOString(),
      });

      return { status: 'completed', ...result };
    } catch (error) {
      await this.jobService.updateJob(jobId, {
        status: 'failed',
        error: error.message,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }
  }
}

module.exports = { SentimentService };