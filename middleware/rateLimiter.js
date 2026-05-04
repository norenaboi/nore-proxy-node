import Config from "../config/index.js";

// IP-level brute-force limiter for admin/auth routes
// Tracks attempt timestamps per IP and rejects if too many occur within the window
const ADMIN_WINDOW_SECONDS = 60;
const ADMIN_MAX_ATTEMPTS = 30;
const adminAttempts = new Map();

setInterval(() => {
  const cutoff = Date.now() / 1000 - ADMIN_WINDOW_SECONDS * 2;
  for (const [ip, timestamps] of adminAttempts.entries()) {
    const fresh = timestamps.filter((t) => t > cutoff);
    if (fresh.length === 0) adminAttempts.delete(ip);
    else adminAttempts.set(ip, fresh);
  }
}, 60000);

export function adminRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now() / 1000;
  const recent = (adminAttempts.get(ip) || []).filter(
    (t) => now - t < ADMIN_WINDOW_SECONDS,
  );
  if (recent.length >= ADMIN_MAX_ATTEMPTS) {
    return res
      .status(429)
      .json({ error: "Too many requests. Please slow down." });
  }
  recent.push(now);
  adminAttempts.set(ip, recent);
  next();
}

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
    const timestamps = this.apiKeyUsage
      .get(apiKey)
      .filter((t) => currentTime - t < 60);
    this.apiKeyUsage.set(apiKey, timestamps);

    if (timestamps.length >= rateLimit) {
      const oldestTimestamp = Math.min(...timestamps);
      let retryAfter = Math.floor(60 - (currentTime - oldestTimestamp));
      retryAfter = Math.max(1, retryAfter);

      const error = new Error(
        `You exceeded your requests per minute limit (${rateLimit}). Please wait and try after ${retryAfter} seconds.`,
      );
      error.statusCode = 429;
      throw error;
    }

    timestamps.push(currentTime);
    this.apiKeyUsage.set(apiKey, timestamps);
  }

  // Periodically evict entries that haven't been used recently to prevent unbounded growth
  startCleanup() {
    setInterval(() => {
      const cutoff = Date.now() / 1000 - 120;
      for (const [key, timestamps] of this.apiKeyUsage.entries()) {
        if (timestamps.every((t) => t < cutoff)) {
          this.apiKeyUsage.delete(key);
        }
      }
    }, 60000);
  }
}

const rateLimiter = new RateLimiter();
export default rateLimiter;
