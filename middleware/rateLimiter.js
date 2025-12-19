import Config from '../config/index.js';

class RateLimiter {
  constructor() {
    this.apiKeyUsage = new Map();
  }

  checkRateLimit(apiKey, rateLimit = Config.RPM_DEFAULT) {
    const currentTime = Date.now() / 1000;

    // Get or initialize timestamps for this API key
    if (!this.apiKeyUsage.has(apiKey)) {
      this.apiKeyUsage.set(apiKey, []);
    }

    // Clean up old timestamps (older than 60 seconds)
    const timestamps = this.apiKeyUsage.get(apiKey).filter(t => currentTime - t < 60);
    this.apiKeyUsage.set(apiKey, timestamps);

    if (timestamps.length >= rateLimit) {
      const oldestTimestamp = Math.min(...timestamps);
      let retryAfter = Math.floor(60 - (currentTime - oldestTimestamp));
      retryAfter = Math.max(1, retryAfter);

      const error = new Error(
        `You exceeded your requests per minute limit (${rateLimit}). Please wait and try after ${retryAfter} seconds.`
      );
      error.statusCode = 429;
      throw error;
    }

    timestamps.push(currentTime);
    this.apiKeyUsage.set(apiKey, timestamps);
  }
}

const rateLimiter = new RateLimiter();
export default rateLimiter;