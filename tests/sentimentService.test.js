const { SentimentService } = require('../src/services/sentimentService');

describe('SentimentService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('uses configured LLM sentiment scores when available', async () => {
    process.env.LLM_API_BASE_URL = 'https://llm.example.com';
    process.env.LLM_API_KEY = 'secret';
    process.env.LLM_MODEL = 'sentiment-model';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify([
                { mentionIndex: 0, score: 0.9 },
                { mentionIndex: 1, score: -0.8 },
              ]),
            },
          },
        ],
      }),
    });

    const articleRepository = {
      getByIds: jest.fn().mockResolvedValue([
        {
          id: 'article-1',
          source: 'manual',
          title: 'AAPL rallies while TSLA slides',
          summary: 'AAPL beats expectations while TSLA cuts guidance.',
          content: 'AAPL rallies after strong demand while TSLA slides after weaker guidance.',
          assets: ['AAPL', 'TSLA'],
          publishedAt: '2026-03-09T10:00:00.000Z',
        },
      ]),
      updateAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const mentionRepository = {
      replaceForArticles: jest.fn().mockResolvedValue(undefined),
    };
    const featureRepository = {
      getRecentBySymbols: jest.fn().mockResolvedValue([]),
      upsertMany: jest.fn().mockResolvedValue(undefined),
    };
    const jobService = {
      updateJob: jest.fn().mockResolvedValue(undefined),
    };

    const service = new SentimentService({
      articleRepository,
      mentionRepository,
      featureRepository,
      jobService,
      queueService: null,
    });

    const result = await service.processAnalysisJob('job-1', {
      source: 'manual',
      articleIds: ['article-1'],
    });

    expect(result.status).toBe('completed');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mentionRepository.replaceForArticles).toHaveBeenCalled();

    const mentions = mentionRepository.replaceForArticles.mock.calls[0][1];
    expect(mentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ llmScore: 0.9, sentimentType: 'positive' }),
        expect.objectContaining({ llmScore: -0.8, sentimentType: 'negative' }),
      ])
    );

    expect(articleRepository.updateAnalysis).toHaveBeenCalledWith(
      'article-1',
      expect.objectContaining({
        metadata: expect.objectContaining({ llmScore: expect.any(Number) }),
      })
    );
  });
});