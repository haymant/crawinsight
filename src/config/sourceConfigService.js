const fs = require('fs');
const yaml = require('js-yaml');
const { db: defaultDb } = require('../db');
const { and, eq } = require('drizzle-orm');
const { crawlinsight_sources } = require('../schema');

// simple helper to convert DB row to source definition
function rowToSource(row) {
  return {
    type: row.type,
    displayName: row.display_name || undefined,
    concurrency: row.concurrency || undefined,
    urls: row.urls || [],
    filters: row.filters,
    params: row.params,
    options: row.options,
    disabled: row.disabled || false,
    storeDir: row.storage_id || undefined,
  };
}

class SourceConfigService {
  constructor(options = {}) {
    // support legacy constructor signature (db client only)
    if (options && typeof options === 'object' && !options.db && !options.configPath) {
      this.db = options || defaultDb;
      this.configPath = undefined;
    } else {
      this.db = options && Object.prototype.hasOwnProperty.call(options, 'db')
        ? options.db
        : defaultDb;
      this.configPath = options && options.configPath;
    }
  }

  async listSources() {
    if (this.db && typeof this.db.select === 'function') {
      const rows = await this.db.select().from(crawlinsight_sources);
      const out = {};
      rows.forEach((r) => {
        out[r.name] = rowToSource(r);
      });
      return out;
    }

    if (this.configPath) {
      try {
        const content = yaml.load(fs.readFileSync(this.configPath, 'utf8')) || {};
        return content.sources || {};
      } catch (e) {
        return {};
      }
    }

    return {};
  }

  async getSource(name) {
    if (this.db && typeof this.db.select === 'function') {
      const rows = await this.db
        .select()
        .from(crawlinsight_sources)
        .where(eq(crawlinsight_sources.name, name));
      if (rows.length === 0) return null;
      return rowToSource(rows[0]);
    }

    if (this.configPath) {
      try {
        const content = yaml.load(fs.readFileSync(this.configPath, 'utf8')) || {};
        return (content.sources || {})[name] || null;
      } catch (e) {
        return null;
      }
    }

    return null;
  }

  async upsertSource(name, definition) {
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
    if (definition.disabled != null && typeof definition.disabled !== 'boolean') {
      throw new Error('Source disabled flag must be boolean');
    }

    const row = {
      name,
      type: definition.type,
      display_name: definition.displayName || null,
      concurrency: definition.concurrency || null,
      urls: definition.urls,
      filters: definition.filters || null,
      params: definition.params || null,
      options: definition.options || null,
      disabled: definition.disabled || false,
      storage_id: definition.storeDir || null,
    };

    if (this.db && typeof this.db.insert === 'function') {
      await this.db
        .insert(crawlinsight_sources)
        .values(row)
        .onConflictDoUpdate({
          target: crawlinsight_sources.name,
          set: {
            type: row.type,
            display_name: row.display_name,
            concurrency: row.concurrency,
            urls: row.urls,
            filters: row.filters,
            params: row.params,
            options: row.options,
            disabled: row.disabled,
            storage_id: row.storage_id,
          },
        });
      return definition;
    }

    if (this.configPath) {
      try {
        const content = yaml.load(fs.readFileSync(this.configPath, 'utf8')) || {};
        content.sources = content.sources || {};
        content.sources[name] = definition;
        fs.writeFileSync(this.configPath, yaml.dump(content), 'utf8');
        return definition;
      } catch (e) {
        throw new Error('Failed to persist source config');
      }
    }

    // fallback: raw SQL
    if (this.db && typeof this.db.execute === 'function') {
      await this.db.execute(
        `INSERT INTO crawlinsight_sources (name, type, display_name, concurrency, urls, filters, params, options, disabled, storage_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (name) DO UPDATE SET
           type = EXCLUDED.type,
           display_name = EXCLUDED.display_name,
           concurrency = EXCLUDED.concurrency,
           urls = EXCLUDED.urls,
           filters = EXCLUDED.filters,
           params = EXCLUDED.params,
           options = EXCLUDED.options,
           disabled = EXCLUDED.disabled,
           storage_id = EXCLUDED.storage_id`,
        [row.name, row.type, row.display_name, row.concurrency, row.urls, row.filters, row.params, row.options, row.disabled, row.storage_id]
      );
      return definition;
    }

    throw new Error('No persistence layer available for source config');
  }

  async deleteSource(name) {
    if (this.db && typeof this.db.delete === 'function') {
      await this.db.delete(crawlinsight_sources).where(eq(crawlinsight_sources.name, name));
      return true;
    }

    if (this.configPath) {
      try {
        const content = yaml.load(fs.readFileSync(this.configPath, 'utf8')) || {};
        if (content.sources && content.sources[name]) {
          delete content.sources[name];
          fs.writeFileSync(this.configPath, yaml.dump(content), 'utf8');
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    }

    if (this.db && typeof this.db.execute === 'function') {
      await this.db.execute(`DELETE FROM crawlinsight_sources WHERE name = $1`, [name]);
      return true;
    }

    return false;
  }
}

module.exports = { SourceConfigService };