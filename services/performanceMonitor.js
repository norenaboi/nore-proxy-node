class PerformanceMonitor {
  constructor() {
    this.requestTimes = [];
    this.maxRequestTimes = 1000;
    this.modelStats = new Map();
  }

  recordRequest(model, duration, success) {
    this.requestTimes.push(duration);
    if (this.requestTimes.length > this.maxRequestTimes) {
      this.requestTimes.shift();
    }

    if (!this.modelStats.has(model)) {
      this.modelStats.set(model, { count: 0, errors: 0 });
    }

    const stats = this.modelStats.get(model);
    stats.count++;
    if (!success) {
      stats.errors++;
    }
  }

  getStats() {
    if (this.requestTimes.length === 0) {
      return { avg_response_time: 0 };
    }

    const sum = this.requestTimes.reduce((a, b) => a + b, 0);
    return {
      avg_response_time: sum / this.requestTimes.length
    };
  }

  getModelStats() {
    const result = {};

    for (const [model, stats] of this.modelStats) {
      result[model] = {
        total_requests: stats.count,
        errors: stats.errors,
        error_rate: stats.count > 0 ? (stats.errors / stats.count * 100) : 0,
        qps: stats.count
      };
    }

    return result;
  }
}

const performanceMonitor = new PerformanceMonitor();
export default performanceMonitor;