const { createApp } = require('./app');
const { buildServices } = require('./bootstrap');

const services = buildServices();
const app = createApp(services);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`CrawInsight API listening on port ${port}`);
});