import Config from '../config/index.js';

class RealtimeStats {
  constructor() {
    this.activeRequests = new Map();
    this.recentRequests = [];
    this.recentErrors = [];
    this.modelUsage = new Map();
    this.maxRecentRequests = Config.MAX_LOG_MEMORY_ITEMS;
    this.maxRecentErrors = 50;
  }

  getModelUsage(model) {
    if (!this.modelUsage.has(model)) {
      this.modelUsage.set(model, {
        requests: 0,
        tokens: 0,
        errors: 0,
        avg_duration: 0
      });
    }
    return this.modelUsage.get(model);
  }

  addRecentRequest(request) {
    this.recentRequests.push(request);
    if (this.recentRequests.length > this.maxRecentRequests) {
      this.recentRequests.shift();
    }
  }

  addRecentError(error) {
    this.recentErrors.push(error);
    if (this.recentErrors.length > this.maxRecentErrors) {
      this.recentErrors.shift();
    }
  }

  cleanupOldRequests() {
    const currentTime = Date.now() / 1000;
    const timeoutRequests = [];

    for (const [reqId, req] of this.activeRequests) {
      if (currentTime - req.start_time > Config.REQUEST_TIMEOUT_SECONDS) {
        timeoutRequests.push(reqId);
      }
    }

    for (const reqId of timeoutRequests) {
      console.warn(`Warning: Request timeout - ${reqId}`);
      this.activeRequests.delete(reqId);
    }
  }
}

const realtimeStats = new RealtimeStats();
export default realtimeStats;