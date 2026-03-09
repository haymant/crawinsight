class JobService {
  constructor() {
    this.jobs = [];
  }

  createJob(type, payload) {
    const job = {
      id: `${Date.now()}-${this.jobs.length + 1}`,
      type,
      payload,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.unshift(job);
    return job;
  }

  updateJob(id, patch) {
    const job = this.jobs.find((entry) => entry.id === id);
    if (!job) {
      return null;
    }
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return job;
  }

  listJobs() {
    return this.jobs;
  }

  getJob(id) {
    return this.jobs.find((entry) => entry.id === id) || null;
  }
}

module.exports = { JobService };