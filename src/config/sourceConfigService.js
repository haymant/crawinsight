const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

class SourceConfigService {
  constructor(configPath) {
    this.configPath = configPath;
  }

  ensureFile() {
    const directory = path.dirname(this.configPath);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, yaml.dump({ sources: {} }));
    }
  }

  readConfig() {
    this.ensureFile();
    const raw = fs.readFileSync(this.configPath, 'utf8');
    const parsed = yaml.load(raw) || {};

    if (!parsed.sources || typeof parsed.sources !== 'object') {
      return { sources: {} };
    }

    return parsed;
  }

  writeConfig(config) {
    this.ensureFile();
    fs.writeFileSync(this.configPath, yaml.dump(config, { noRefs: true }));
  }

  listSources() {
    return this.readConfig().sources;
  }

  getSource(name) {
    return this.listSources()[name];
  }

  upsertSource(name, definition) {
    if (!name) {
      throw new Error('Source name is required');
    }
    if (!definition || typeof definition !== 'object') {
      throw new Error('Source definition is required');
    }
    if (!definition.type) {
      throw new Error('Source type is required');
    }
    if (!Array.isArray(definition.urls) || definition.urls.length === 0) {
      throw new Error('Source urls are required');
    }

    const config = this.readConfig();
    config.sources[name] = definition;
    this.writeConfig(config);
    return config.sources[name];
  }

  deleteSource(name) {
    const config = this.readConfig();
    const exists = Boolean(config.sources[name]);
    if (exists) {
      delete config.sources[name];
      this.writeConfig(config);
    }
    return exists;
  }
}

module.exports = { SourceConfigService };