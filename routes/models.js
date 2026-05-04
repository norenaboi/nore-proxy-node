import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { verifyApiKey } from "../middleware/auth.js";
import { MODEL_REGISTRY } from "../utils/helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.get("/v1/models", async (req, res) => {
  const modelsData = [];
  const modelAliases = {};

  try {
    const filePath = path.join(__dirname, "..", "allowed_models.txt");
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        let displayName;

        if (trimmed.includes(":")) {
          const [alias, actualName] = trimmed.split(":", 2);
          modelAliases[alias.trim()] = actualName.trim();
          displayName = alias.trim();
        } else {
          displayName = trimmed;
        }

        modelsData.push({
          id: displayName,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "nore-proxy",
          type: "chat",
        });
      }
    }
  } catch (error) {
    // If no file exists, return models from registry
    for (const [modelName, modelInfo] of Object.entries(MODEL_REGISTRY)) {
      modelsData.push({
        id: modelName,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "nore-proxy",
        type: modelInfo.type || "chat",
      });
    }
  }

  res.json({
    object: "list",
    data: modelsData,
  });
});

export default router;
