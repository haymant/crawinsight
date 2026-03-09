const rssPlugin = require('./rss');
const transcriptsPlugin = require('./transcripts');

const plugins = {
  rss: rssPlugin,
  transcripts: transcriptsPlugin,
};

function getPlugin(type) {
  const plugin = plugins[type];
  if (!plugin) {
    throw new Error(`Unsupported source type: ${type}`);
  }
  return plugin;
}

module.exports = { getPlugin };