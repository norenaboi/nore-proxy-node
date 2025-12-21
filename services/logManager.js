import path from 'path';
import Database from 'better-sqlite3';
import Config from '../config/index.js';

class LogManager {
  constructor() {
    const dbPath = path.join(Config.LOG_DIR, 'logs.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        type TEXT,
        model TEXT,
        data TEXT
      );
      CREATE TABLE IF NOT EXISTS error_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_type ON request_logs(type);
      CREATE INDEX IF NOT EXISTS idx_request_model ON request_logs(model);
    `);
  }

  writeRequestLog(logEntry) {
    const stmt = this.db.prepare(
      'INSERT INTO request_logs (timestamp, type, model, data) VALUES (?, ?, ?, ?)'
    );
    stmt.run(logEntry.timestamp || new Date().toISOString(), logEntry.type, logEntry.model, JSON.stringify(logEntry));
  }

  writeErrorLog(logEntry) {
    const stmt = this.db.prepare(
      'INSERT INTO error_logs (timestamp, data) VALUES (?, ?)'
    );
    stmt.run(logEntry.timestamp || new Date().toISOString(), JSON.stringify(logEntry));
  }

  readRequestLogs(limit = 100, offset = 0, model = null) {
    const query = model
      ? 'SELECT data FROM request_logs WHERE type = ? AND model = ? ORDER BY id DESC LIMIT ? OFFSET ?'
      : 'SELECT data FROM request_logs WHERE type = ? ORDER BY id DESC LIMIT ? OFFSET ?';
    
    const params = model
      ? ['request_end', model, limit, offset]
      : ['request_end', limit, offset];
    
    const rows = this.db.prepare(query).all(...params);
    return rows.map(row => JSON.parse(row.data));
  }

  readErrorLogs(limit = 50) {
    const rows = this.db.prepare(
      'SELECT data FROM error_logs ORDER BY id DESC LIMIT ?'
    ).all(limit);
    return rows.map(row => JSON.parse(row.data));
  }
}

const logManager = new LogManager();
export default logManager;