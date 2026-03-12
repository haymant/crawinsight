const rssPlugin = require('./rss');
const redditPlugin = require('./reddit');
const transcriptsPlugin = require('./transcripts');
const xPlugin = require('./x');

const plugins = {
  rss: rssPlugin,
  reddit: redditPlugin,
  transcripts: transcriptsPlugin,
  x: xPlugin,
};

function getPlugin(type) {
  const plugin = plugins[type];
  if (!plugin) {
    throw new Error(`Unsupported source type: ${type}`);
  }
  return plugin;
}

module.exports = { getPlugin };