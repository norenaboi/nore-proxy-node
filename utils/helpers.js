import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Config from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Model registry and aliases
export let MODEL_ALIASES = {};
export let MODEL_REGISTRY = {};

export function resolveModelName(modelName) {
  return MODEL_ALIASES[modelName] || modelName;
}

export function loadModelsFromFile() {
  MODEL_REGISTRY = {};
  MODEL_ALIASES = {};

  const filePath = path.join(__dirname, '..', 'allowed_models.txt');

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        let modelName;

        if (trimmed.includes(':')) {
          const [alias, actualName] = trimmed.split(':', 2);
          MODEL_ALIASES[alias.trim()] = actualName.trim();
          modelName = alias.trim();
        } else {
          modelName = trimmed;
        }

        MODEL_REGISTRY[modelName] = {
          type: 'chat',
          capabilities: {
            outputCapabilities: {}
          }
        };
      }
    }

    console.log(`Loaded ${Object.keys(MODEL_REGISTRY).length} models from allowed_models.txt`);
    if (Object.keys(MODEL_ALIASES).length > 0) {
      console.log(`Loaded ${Object.keys(MODEL_ALIASES).length} model aliases`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error loading models:', error);
    } else {
      console.warn('allowed_models.txt not found');
    }
  }
}

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.floor(String(text).length / 4);
}

export function getEndpointForModel(modelName) {
  const actualModelName = resolveModelName(modelName);
  const match = actualModelName.match(/-v(\d+)$/);

  if (match) {
    const version = match[1];
    const endpointKey = `v${version}`;

    if (Config.ENDPOINTS[endpointKey]) {
      const endpoint = Config.ENDPOINTS[endpointKey];
      const actualModel = actualModelName.replace(new RegExp(`-v${version}$`), '');
      return {
        url: endpoint.url,
        token: endpoint.token,
        actualModel
      };
    }
  }

  return null;
}