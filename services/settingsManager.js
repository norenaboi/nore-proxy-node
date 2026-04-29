import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETTINGS_PATH = path.join(__dirname, '..', 'config', 'settings.json');

/**
 * Default settings – add new toggles/values here as the panel grows.
 */
const DEFAULTS = {
  promptCachingEnabled: true,
  promptCachingDepth: 1,
};

class SettingsManager {
  constructor() {
    this._settings = { ...DEFAULTS };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        // Merge with defaults so new keys are always present
        this._settings = { ...DEFAULTS, ...parsed };
      } else {
        // Write defaults on first run
        this._persist();
      }
    } catch (err) {
      console.error('[SettingsManager] Failed to load settings, using defaults:', err.message);
      this._settings = { ...DEFAULTS };
    }
  }

  _persist() {
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(this._settings, null, 2), 'utf-8');
    } catch (err) {
      console.error('[SettingsManager] Failed to save settings:', err.message);
    }
  }

  get(key) {
    return this._settings[key];
  }

  getAll() {
    return { ...this._settings };
  }

  set(key, value) {
    if (!(key in DEFAULTS)) {
      throw Object.assign(new Error(`Unknown setting: "${key}"`), { statusCode: 400 });
    }
    this._settings[key] = value;
    this._persist();
  }

  update(updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in DEFAULTS)) {
        throw Object.assign(new Error(`Unknown setting: "${key}"`), { statusCode: 400 });
      }
      this._settings[key] = value;
    }
    this._persist();
  }

  reload() {
    this._load();
  }
}

export default new SettingsManager();
