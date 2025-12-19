import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Config from '../config/index.js';
import logManager from './logManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class APIKeyManager {
  constructor(keyFile = 'api_keys.json') {
    this.keyFile = path.join(__dirname, '..', keyFile);
    this.keys = {};
    this.loadKeys();
  }

  loadKeys() {
    try {
      const data = fs.readFileSync(this.keyFile, 'utf-8');
      const parsed = JSON.parse(data);
      this.keys = parsed.keys || {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error loading keys:', error);
      }
      this.keys = {};
    }
  }

  saveKeys() {
    fs.writeFileSync(this.keyFile, JSON.stringify({ keys: this.keys }, null, 2));
  }

  getKeys() {
    return Object.keys(this.keys).map(key => ({
      api_key: key,
      name: this.keys[key].name || 'Unnamed',
      active: this.keys[key].active || false,
      usage_today: this.keys[key].usage_today || 'NaN',
      rpd: this.keys[key].rpd || 'NaN'
    }));
  }

  validateKey(apiKey) {
    if (!this.keys[apiKey]) {
      const error = new Error('Invalid API Key');
      error.statusCode = 401;
      throw error;
    }
    return true;
  }

  checkForGeneration(apiKey, rateLimiter) {
    if (!this.keys[apiKey]) {
      const error = new Error('Invalid API Key');
      error.statusCode = 401;
      throw error;
    }

    const keyData = this.keys[apiKey];

    // Check if key is active
    if (!keyData.active) {
      const error = new Error('Your API Key is deactivated. Please contact the admin for reactivation.');
      error.statusCode = 403;
      throw error;
    }

    // Check RPD limit
    const rpdLimit = keyData.rpd || Config.RPD_DEFAULT;
    if (parseInt(keyData.usage_today) >= parseInt(rpdLimit)) {
      const error = new Error(`You exceeded your requests per day limit (${rpdLimit}). Please wait until it resets at midnight.`);
      error.statusCode = 429;
      throw error;
    }

    // Check rate limit (RPM)
    rateLimiter.checkRateLimit(apiKey, Config.RPM_DEFAULT);

    // Increment usage
    this.rateLimitIncrement(apiKey);

    return true;
  }

  rateLimitIncrement(apiKey) {
    if (!this.keys[apiKey]) {
      const error = new Error('Invalid API Key');
      error.statusCode = 401;
      throw error;
    }

    this.keys[apiKey].usage_today = (this.keys[apiKey].usage_today || 0) + 1;
    this.saveKeys();
    return true;
  }

  resetDaily() {
    const currentDate = new Date().toISOString().split('T')[0];

    for (const apiKey of Object.keys(this.keys)) {
      const keyData = this.keys[apiKey];

      if (keyData.last_reset_date !== currentDate) {
        keyData.usage_today = 0;
        keyData.last_reset_date = currentDate;
      }
    }
    this.saveKeys();
  }

  addKey(apiKey, name, rpd = Config.RPD_DEFAULT) {
    this.keys[apiKey] = {
      name,
      active: true,
      rpd,
      usage_today: 0,
      last_reset_date: new Date().toISOString().split('T')[0]
    };
    this.saveKeys();
  }

  removeKey(apiKey) {
    if (this.keys[apiKey]) {
      delete this.keys[apiKey];
      this.saveKeys();
      return true;
    }
    return false;
  }

  updateKey(apiKey, name, rpd, active) {
    if (this.keys[apiKey]) {
      this.keys[apiKey].name = name;
      this.keys[apiKey].rpd = rpd;
      this.keys[apiKey].active = active;
      this.saveKeys();
    } else {
      const error = new Error(`This API key does not exist: ${apiKey}`);
      error.statusCode = 404;
      throw error;
    }
  }

  getKeyName(apiKey) {
    try {
      this.validateKey(apiKey);
      return this.keys[apiKey].name;
    } catch {
      return 'Unknown';
    }
  }

  getUsageStats(apiKey) {
    const logs = logManager.readRequestLogs(10000);
    const currentTime = Date.now() / 1000;
    const dayAgo = currentTime - 86400;

    const apiKeyLogs24h = logs.filter(
      log => log.api_key === apiKey && (log.timestamp || 0) > dayAgo
    );

    const apiKeyLogsAll = logs.filter(log => log.api_key === apiKey);

    return {
      name: this.keys[apiKey]?.name || '',
      daily_requests: this.keys[apiKey]?.usage_today || 0,
      total_requests: apiKeyLogsAll.length,
      total_input_tokens: apiKeyLogsAll.reduce((sum, log) => sum + (log.input_tokens || 0), 0),
      total_output_tokens: apiKeyLogsAll.reduce((sum, log) => sum + (log.output_tokens || 0), 0),
      daily_input_tokens: apiKeyLogs24h.reduce((sum, log) => sum + (log.input_tokens || 0), 0),
      daily_output_tokens: apiKeyLogs24h.reduce((sum, log) => sum + (log.output_tokens || 0), 0),
      rate_limit: this.keys[apiKey]?.rpd || 0,
      active: this.keys[apiKey]?.active || false
    };
  }
}

const apiKeyManager = new APIKeyManager();
export default apiKeyManager;