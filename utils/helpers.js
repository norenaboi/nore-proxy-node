import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Config from "../config/index.js";

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

  const filePath = path.join(__dirname, "..", "allowed_models.txt");

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        let modelName;

        if (trimmed.includes(":")) {
          const [alias, actualName] = trimmed.split(":", 2);
          MODEL_ALIASES[alias.trim()] = actualName.trim();
          modelName = alias.trim();
        } else {
          modelName = trimmed;
        }

        MODEL_REGISTRY[modelName] = {
          type: "chat",
          capabilities: {
            outputCapabilities: {},
          },
        };
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Error loading models:", error);
    } else {
      console.warn("allowed_models.txt not found");
    }
  }
}

/**
 * Determines if a model name refers to a Claude model.
 */
export function isClaudeModel(modelName) {
  return /claude/i.test(modelName);
}

/**
 * Applies Claude prompt caching to a messages array.
 *
 * cache_depth semantics:
 *   -1  → caching disabled, messages returned unchanged
 *    0  → cache every message
 *    N  → cache every message except the last N messages
 *         (i.e. messages[0 .. length-N] get cache_control)
 *
 * Cache breakpoints are inserted by adding `cache_control: { type: "ephemeral" }`
 * to the last content block of each eligible message, which is the format
 * OpenRouter (and the Anthropic API directly) understand.
 *
 * @param {Array} messages - OpenAI-style messages array
 * @param {number} cacheDepth - cache depth value
 * @returns {Array} - new messages array with cache_control injected where appropriate
 */
export function applyClaudePromptCaching(messages, cacheDepth) {
  // -1 means caching is disabled
  if (cacheDepth === -1) {
    return messages;
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // Determine the index boundary: messages at index < cacheUntil get cached
  // cacheDepth 0  → cache all  → cacheUntil = messages.length
  // cacheDepth N  → skip last N → cacheUntil = messages.length - N
  const cacheUntil = Math.max(0, messages.length - cacheDepth);

  // Anthropic allows a maximum of 4 cache breakpoints per request.
  // Pick up to 4 evenly distributed indices within the eligible range [0, cacheUntil).
  const MAX_BREAKPOINTS = 4;
  const eligibleCount = cacheUntil;
  const breakpointIndices = new Set();

  if (eligibleCount > 0) {
    const count = Math.min(MAX_BREAKPOINTS, eligibleCount);
    for (let i = 0; i < count; i++) {
      // Distribute evenly, always including the last eligible message
      const idx = Math.round((i / (count - 1 || 1)) * (eligibleCount - 1));
      breakpointIndices.add(idx);
    }
  }

  return messages.map((message, index) => {
    if (!breakpointIndices.has(index)) {
      return message;
    }

    return addCacheControlToMessage(message);
  });
}

/**
 * Adds a cache_control breakpoint to the last content block of a message.
 * Handles both string content and array-of-blocks content.
 */
function addCacheControlToMessage(message) {
  if (!message || !message.content) {
    return message;
  }

  const cacheControl = { type: "ephemeral" };

  if (typeof message.content === "string") {
    // Convert string content to a content block array so we can attach cache_control
    return {
      ...message,
      content: [
        {
          type: "text",
          text: message.content,
          cache_control: cacheControl,
        },
      ],
    };
  }

  if (Array.isArray(message.content)) {
    // Clone the array and attach cache_control to the last block
    const blocks = message.content.map((block, i) => {
      if (i === message.content.length - 1) {
        return { ...block, cache_control: cacheControl };
      }
      return block;
    });

    return { ...message, content: blocks };
  }

  // Unknown content shape – return unchanged
  return message;
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
      const actualModel = actualModelName.replace(
        new RegExp(`-v${version}$`),
        "",
      );
      return {
        url: endpoint.url,
        token: endpoint.token,
        actualModel,
      };
    }
  }

  return null;
}
