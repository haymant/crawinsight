const rssPlugin = require('./rss');

async function parse(input) {
  const items = await rssPlugin.parse(input);
  return items.map((item) => ({
    ...item,
    asset: input.metadata?.ticker || null,
  }));
}

module.exports = {
  parse,
  expandRequests: rssPlugin.expandRequests,
};