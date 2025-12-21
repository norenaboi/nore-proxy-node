import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

class Config {
  static LOG_DIR = path.join(__dirname, '..', 'logs');

  static PORT = parseInt(process.env.PORT || 8741);

  static REQUEST_TIMEOUT_SECONDS = 180;
  static STATS_UPDATE_INTERVAL = 5;
  static CLEANUP_INTERVAL = 300;

  static MAX_LOG_MEMORY_ITEMS = 1000;
  static MAX_REQUEST_DETAILS = 500;

  static MASTER_KEY = process.env.MASTER_KEY || 'admin';
  static RPD_DEFAULT = parseInt(process.env.RPD_DEFAULT || '500', 10);
  static RPM_DEFAULT = parseInt(process.env.RPM_DEFAULT || '10', 10);

  static ENDPOINTS = {};

  static loadEndpoints() {
    this.ENDPOINTS = {};
    
    const endpointsPath = path.join(__dirname, '..', 'endpoints.txt');
    
    if (!fs.existsSync(endpointsPath)) {
      console.log('endpoints.txt not found, no endpoints loaded');
      return this.ENDPOINTS;
    }
    
    const content = fs.readFileSync(endpointsPath, 'utf-8');
    const lines = content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    
    const urlMap = {};
    const tokenMap = {};
    
    for (const line of lines) {
      const urlMatch = line.match(/^V(\d+)_URL=(.+)$/);
      const tokenMatch = line.match(/^V(\d+)_TOKEN=(.+)$/);
      
      if (urlMatch) {
        urlMap[urlMatch[1]] = urlMatch[2];
      } else if (tokenMatch) {
        tokenMap[tokenMatch[1]] = tokenMatch[2];
      }
    }
    
    for (const index of Object.keys(urlMap)) {
      if (tokenMap[index]) {
        this.ENDPOINTS[`v${index}`] = {
          url: urlMap[index],
          token: tokenMap[index]
        };
      }
    }

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