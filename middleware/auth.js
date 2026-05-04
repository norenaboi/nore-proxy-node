import crypto from "crypto";
import apiKeyManager from "../services/apiKeyManager.js";
import Config from "../config/index.js";

export function verifyApiKey(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Invalid authorization header format. Expected 'Bearer <token>'",
    });
  }

  const apiKey = authorization.replace("Bearer ", "");

  try {
    apiKeyManager.validateKey(apiKey);
    req.apiKey = apiKey;
    next();
  } catch (error) {
    return res.status(error.statusCode || 401).json({
      error: error.message || "Invalid or missing API key",
    });
  }
}

export function verifyApiKeyForStats(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Invalid authorization header format. Expected 'Bearer <token>'",
    });
  }

  const apiKey = authorization.replace("Bearer ", "");

  try {
    apiKeyManager.validateKey(apiKey);
    req.apiKey = apiKey;
    next();
  } catch (error) {
    return res.status(error.statusCode || 401).json({
      error: error.message || "Invalid or missing API key",
    });
  }
}

export function verifyMasterKey(req, res, next) {
  const provided = req.headers.authorization || "";
  const expected = Config.MASTER_KEY;
  let valid = false;
  try {
    valid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch (_) {}

  if (!valid) {
    return res.status(403).json({ error: "Invalid master key" });
  }

  next();
}
