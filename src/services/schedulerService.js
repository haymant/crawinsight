const cron = require('node-cron');

class SchedulerService {
  constructor(crawlService) {
    this.crawlService = crawlService;
    this.tasks = new Map();
  }

  async addSchedule({ name, source, expression }) {
    if (!name || !source || !expression) {
      throw new Error('Schedule name, source, and expression are required');
    }
    const sourceConfig = await this.crawlService.sourceConfigService.getSource(source);
    if (!sourceConfig) {
      throw new Error('Unknown source');
    }
    if (sourceConfig.disabled) {
      throw new Error('Source is disabled');
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

  deleteSchedule(name) {
    const existing = this.tasks.get(name);
    if (!existing) {
      return false;
    }
    existing.task.stop();
    this.tasks.delete(name);
    return true;
  }

  stopAll() {
    for (const entry of this.tasks.values()) {
      entry.task.stop();
    }
    this.tasks.clear();
  }
}

module.exports = { SchedulerService };