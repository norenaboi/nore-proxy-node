import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

class Config {
  static LOG_DIR = path.join(__dirname, '..', 'logs');
  static REQUEST_LOG_FILE = 'requests.jsonl';
  static ERROR_LOG_FILE = 'errors.jsonl';
  static MAX_LOG_SIZE = 50 * 1024 * 1024; // 50MB
  static MAX_LOG_FILES = 50;

  static HOST = '127.0.0.1';
  static PORT = 8741;

  static REQUEST_TIMEOUT_SECONDS = 180;
  static STATS_UPDATE_INTERVAL = 5;
  static CLEANUP_INTERVAL = 300;

  static MAX_LOG_MEMORY_ITEMS = 1000;
  static MAX_REQUEST_DETAILS = 500;

  static MASTER_KEY = process.env.MASTER_KEY;
  static RPD_DEFAULT = parseInt(process.env.RPD_DEFAULT || '500', 10);
  static RPM_DEFAULT = parseInt(process.env.RPM_DEFAULT || '10', 10);

  static ENDPOINTS = {};

  static loadEndpoints() {
    this.ENDPOINTS = {};
    let i = 1;

    while (true) {
      const url = process.env[`V${i}_URL`];
      const token = process.env[`V${i}_TOKEN`];

      if (url && token) {
        this.ENDPOINTS[`v${i}`] = { url, token };
        i++;
      } else if (i > 100) {
        break;
      } else {
        // Check for gaps
        let foundMore = false;
        for (let j = i + 1; j < i + 11; j++) {
          if (process.env[`V${j}_URL`]) {
            foundMore = true;
            break;
          }
        }
        if (!foundMore) break;
        i++;
      }
    }

    console.log(`Loaded ${Object.keys(this.ENDPOINTS).length} endpoints from environment`);
    return this.ENDPOINTS;
  }

  static reload() {
    dotenv.config({ override: true });
    this.MASTER_KEY = process.env.MASTER_KEY;
    this.RPD_DEFAULT = parseInt(process.env.RPD_DEFAULT || '500', 500);
    this.RPM_DEFAULT = parseInt(process.env.RPM_DEFAULT || '10', 10);
    this.loadEndpoints();
  }
}

export default Config;