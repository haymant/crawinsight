const fs = require('fs');
const path = require('path');
const { extractArticleLinks } = require('../src/utils/linkExtractor');

describe('linkExtractor', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');
  const cases = [
    {
      file: 'bloomberg.xml',
      options: {},
      expectedPattern: /https:\/\/www\.bloomberg\.com\/news\//,
    },
    {
      file: 'cnbc.xml',
      options: {},
      expectedPattern: /https:\/\/www\.cnbc\.com\/2026\//,
    },
    {
      file: 'google.xml',
      options: {},
      expectedPattern: /https:\/\/news\.google\.com\/rss\/articles\//,
    },
    {
      file: 'nytimes.xml',
      options: {},
      expectedPattern: /https:\/\/www\.nytimes\.com\/2026\//,
    },
    {
      file: 'seekingalpha.xml',
      options: {},
      expectedPattern: /https:\/\/seekingalpha\.com\/(article|news)\//,
    },
    {
      file: 'reddit.json',
      options: { baseUrl: 'https://www.reddit.com' },
      expectedPattern: /https:\/\/www\.reddit\.com\/r\/stocks\/comments\//,
    },
    {
      file: 'reddit.xml',
      options: {},
      expectedPattern: /https:\/\/www\.reddit\.com\/r\/stocks\/comments\//,
    },
  ];

  test('extracts valid article links from at least 90% of fixtures', () => {
    const successes = cases.filter(({ file, options, expectedPattern }) => {
      const body = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
      const links = extractArticleLinks(body, options);
      return links.some((link) => expectedPattern.test(link));
    }).length;

    expect(successes / cases.length).toBeGreaterThanOrEqual(0.9);
    expect(successes).toBe(cases.length);
  });

  test.each(cases)('extracts expected article links from %s', ({ file, options, expectedPattern }) => {
    const body = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
    const links = extractArticleLinks(body, options);

    expect(links.length).toBeGreaterThan(0);
    expect(links.some((link) => expectedPattern.test(link))).toBe(true);
  });
});