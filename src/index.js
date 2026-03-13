// load any environment variables defined in .env.local (e.g. Reddit credentials)
require('dotenv').config({ path: '.env.local' });

const { createApp } = require('./app');
const { buildServices } = require('./bootstrap');

async function main() {
  const services = buildServices();
  await services.start();

  const app = createApp(services);
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => {
    console.log(`CrawlInsight API listening on port ${port}`);
  });

  const shutdown = async () => {
    server.close();
    await services.stop();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});