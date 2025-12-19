import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import Config from '../config/index.js';

class LogManager {
  constructor() {
    // Ensure log directory exists
    if (!fs.existsSync(Config.LOG_DIR)) {
      fs.mkdirSync(Config.LOG_DIR, { recursive: true });
    }

    this.requestLogPath = path.join(Config.LOG_DIR, Config.REQUEST_LOG_FILE);
    this.errorLogPath = path.join(Config.LOG_DIR, Config.ERROR_LOG_FILE);

    // Create empty log files if they don't exist
    if (!fs.existsSync(this.requestLogPath)) {
      fs.writeFileSync(this.requestLogPath, '');
    }
    if (!fs.existsSync(this.errorLogPath)) {
      fs.writeFileSync(this.errorLogPath, '');
    }

    this.checkAndRotate();
  }

  checkAndRotate() {
    for (const logPath of [this.requestLogPath, this.errorLogPath]) {
      try {
        const stats = fs.statSync(logPath);
        if (stats.size > Config.MAX_LOG_SIZE) {
          this.rotateLog(logPath);
        }
      } catch (error) {
        // File might not exist yet
      }
    }
  }

  rotateLog(logPath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const rotatedPath = logPath.replace('.jsonl', `.${timestamp}.jsonl`);

    fs.renameSync(logPath, rotatedPath);

    // Compress the rotated file
    const fileContent = fs.readFileSync(rotatedPath);
    const compressed = zlib.gzipSync(fileContent);
    fs.writeFileSync(`${rotatedPath}.gz`, compressed);
    fs.unlinkSync(rotatedPath);

    this.cleanupOldLogs();
  }

  cleanupOldLogs() {
    const files = fs.readdirSync(Config.LOG_DIR)
      .filter(f => f.endsWith('.jsonl.gz'))
      .map(f => ({
        name: f,
        path: path.join(Config.LOG_DIR, f),
        mtime: fs.statSync(path.join(Config.LOG_DIR, f)).mtime
      }))
      .sort((a, b) => a.mtime - b.mtime);

    while (files.length > Config.MAX_LOG_FILES) {
      const oldest = files.shift();
      fs.unlinkSync(oldest.path);
      console.log(`Deleted old log: ${oldest.name}`);
    }
  }

  writeRequestLog(logEntry) {
    this.checkAndRotate();
    fs.appendFileSync(this.requestLogPath, JSON.stringify(logEntry) + '\n', 'utf-8');
  }

  writeErrorLog(logEntry) {
    this.checkAndRotate();
    fs.appendFileSync(this.errorLogPath, JSON.stringify(logEntry) + '\n', 'utf-8');
  }

  readRequestLogs(limit = 100, offset = 0, model = null) {
    const logs = [];

    try {
      if (fs.existsSync(this.requestLogPath)) {
        const content = fs.readFileSync(this.requestLogPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const log = JSON.parse(lines[i]);
            if (log.type === 'request_end') {
              if (model && log.model !== model) continue;
              logs.push(log);
              if (logs.length >= limit + offset) break;
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    } catch (error) {
      console.error('Error reading request logs:', error);
    }

    return logs.slice(offset, offset + limit);
  }

  readErrorLogs(limit = 50) {
    const logs = [];

    try {
      if (fs.existsSync(this.errorLogPath)) {
        const content = fs.readFileSync(this.errorLogPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
          try {
            logs.push(JSON.parse(lines[i]));
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    } catch (error) {
      console.error('Error reading error logs:', error);
    }

    return logs.reverse();
  }
}

const logManager = new LogManager();
export default logManager;