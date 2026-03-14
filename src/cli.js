require('dotenv').config({ path: '.env.local' });

const { buildServices } = require('./bootstrap');

async function main() {
  // simple argument parsing: we expect the first non-option token to be the
  // source name, and support `--config <path>` and `--store <dir>` options.
  const args = process.argv.slice(2);
  let configPath = null;
  let storeDir = null;
  let source = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && i + 1 < args.length) {
      configPath = args[++i];
    } else if (arg === '--store' && i + 1 < args.length) {
      storeDir = args[++i];
    } else if (!source) {
      source = arg;
    } else {
      // ignore extras
    }
  }

  if (!source) {
    throw new Error('Usage: npm run cli -- [--config path] [--store dir] <source-name>');
  }

  const overrides = {};
  if (configPath) overrides.configPath = configPath;
  if (storeDir) {
    const path = require('path');
    overrides.dataPath = path.join(storeDir, 'articles.json');
    overrides.rawContentPath = path.join(storeDir, 'raw');
  }

  const services = buildServices(overrides);

  try {
    if (typeof services.articleRepository?.ensureFile === 'function') {
      services.articleRepository.ensureFile();
    }
    await services.start();
    const result = await services.crawlService.runSource(source, { forceInline: true });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await services.stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});