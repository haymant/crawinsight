require('dotenv').config({ path: '.env.local' });

const { buildServices } = require('./bootstrap');

async function main() {
  const source = process.argv[2];
  if (!source) {
    throw new Error('Usage: npm run cli -- <source-name>');
  }

  const services = buildServices();
  const result = await services.crawlService.runSource(source);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});