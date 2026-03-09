const cron = require('node-cron');

class SchedulerService {
  constructor(crawlService) {
    this.crawlService = crawlService;
    this.tasks = new Map();
  }

  addSchedule({ name, source, expression }) {
    if (!name || !source || !expression) {
      throw new Error('Schedule name, source, and expression are required');
    }
    if (!this.crawlService.sourceConfigService.getSource(source)) {
      throw new Error('Unknown source');
    }
    if (!cron.validate(expression)) {
      throw new Error('Invalid cron expression');
    }
    if (this.tasks.has(name)) {
      this.tasks.get(name).task.stop();
    }

    const task = cron.schedule(expression, async () => {
      await this.crawlService.runSource(source);
    });

    this.tasks.set(name, {
      name,
      source,
      expression,
      createdAt: new Date().toISOString(),
      task,
    });

    return this.getSchedules().find((entry) => entry.name === name);
  }

  getSchedules() {
    return [...this.tasks.values()].map(({ task, ...schedule }) => schedule);
  }

  stopAll() {
    for (const entry of this.tasks.values()) {
      entry.task.stop();
    }
    this.tasks.clear();
  }
}

module.exports = { SchedulerService };