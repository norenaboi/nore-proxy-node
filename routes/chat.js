import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { verifyApiKey } from "../middleware/auth.js";
import apiKeyManager from "../services/apiKeyManager.js";
import rateLimiter from "../middleware/rateLimiter.js";
import { logRequestStart, logRequestEnd, logError } from "../utils/logging.js";
import {
  MODEL_REGISTRY,
  getEndpointForModel,
  estimateTokens,
  resolveModelName,
  isClaudeModel,
  applyClaudePromptCaching,
} from "../utils/helpers.js";
import settingsManager from "../services/settingsManager.js";

const router = express.Router();

router.post("/v1/chat/completions", verifyApiKey, async (req, res) => {
  const apiKey = req.apiKey;

  try {
    apiKeyManager.checkForGeneration(apiKey, rateLimiter);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }

  const openaiReq = req.body;
  const requestId = uuidv4();
  const isStreaming = openaiReq.stream !== false;
  const modelName = openaiReq.model;

  // Extract and remove cache_depth before forwarding.
  // Per-request override takes priority; falls back to the admin panel setting.
  let cacheDepth;
  if (openaiReq.cache_depth !== undefined) {
    cacheDepth = parseInt(openaiReq.cache_depth, 10);
  } else {
    const cachingEnabled = settingsManager.get("promptCachingEnabled");
    cacheDepth = cachingEnabled
      ? settingsManager.get("promptCachingDepth")
      : -1;
  }
  delete openaiReq.cache_depth;

  // Validate model
  const modelInfo = MODEL_REGISTRY[modelName];
  if (!modelInfo) {
    return res.status(404).json({ error: `Model '${modelName}' not found.` });
  }

  // Remove unwanted parameters
  const paramsToExclude = ["frequency_penalty", "presence_penalty"];
  for (const param of paramsToExclude) {
    delete openaiReq[param];
  }

  // Log request start
  const requestParams = {
    temperature: openaiReq.temperature,
    max_tokens: openaiReq.max_tokens,
    streaming: isStreaming,
  };
  const messages = openaiReq.messages || [];
  logRequestStart(requestId, modelName, requestParams, messages, apiKey);

  try {
    if (isStreaming) {
      await streamFromBackend(
        req,
        res,
        requestId,
        openaiReq,
        modelName,
        apiKey,
        cacheDepth,
      );
    } else {
      const responseData = await makeBackendRequest(
        requestId,
        openaiReq,
        modelName,
        apiKey,
        cacheDepth,
      );
      res.json(responseData);
    }
  } catch (error) {
    logRequestEnd(requestId, false, 0, 0, error.message);
    console.error(`API [ID: ${requestId}]: Exception:`, error);
    res.status(500).json({
      error: `Error: ${error}`,
    });
  }
});

async function streamFromBackend(
  req,
  res,
  requestId,
  openaiReq,
  modelName,
  apiKey,
  cacheDepth = -1,
) {
  let accumulatedContent = "";

  const endpointInfo = getEndpointForModel(modelName);

  if (!endpointInfo) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const errorResponse = {
      error: {
        message: "Error 404: Can't find the model you're looking for.",
        type: "server_error",
        code: 404,
      },
    };
    res.write(`data: ${JSON.stringify(errorResponse)}\n\ndata: [DONE]\n\n`);
    res.end();
    return;
  }

  const { url: backendUrl, token: backendToken, actualModel } = endpointInfo;
  const fullUrl = `${backendUrl}/chat/completions`;

  // Set streaming headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    let messages = openaiReq.messages || [];
    let streamUsage = null;

    // Apply Claude prompt caching if the target model is Claude and caching is enabled
    if (isClaudeModel(actualModel) && cacheDepth !== -1) {
      messages = applyClaudePromptCaching(messages, cacheDepth);
      console.log(
        `Prompt caching applied (depth=${cacheDepth}): ${
          messages.filter((m) => {
            const content = m.content;
            if (Array.isArray(content))
              return content.some((b) => b.cache_control);
            return false;
          }).length
        } message(s) marked for caching`,
      );
    }

    const data = {
      model: actualModel,
      stream: true,
      messages,
      max_tokens: openaiReq.max_tokens,
      temperature: openaiReq.temperature,
      top_p: openaiReq.top_p,
      tools: openaiReq.tools,
      tool_choice: openaiReq.tool_choice,
    };

    // Remove undefined values
    Object.keys(data).forEach((key) => {
      if (data[key] === undefined || data[key] === null) {
        delete data[key];
      }
    });

    const response = await axios({
      method: "post",
      url: fullUrl,
      headers: {
        Authorization: `Bearer ${backendToken}`,
        "Content-Type": "application/json",
      },
      data,
      responseType: "stream",
      timeout: 180000,
    });

    if (response.status !== 200) {
      const errorResponse = {
        error: {
          message: `Error ${response.status}: ${response.data.statusMessage}`,
          type: "server_error",
          code: response.status,
        },
      };
      res.write(`data: ${JSON.stringify(errorResponse)}\n\ndata: [DONE]\n\n`);
      res.end();
      return;
    }

    let buffer = "";

    response.data.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6).trim();

          if (payload === "[DONE]") {
            res.write("data: [DONE]\n\n");
            return;
          }

          try {
            const chunkData = JSON.parse(payload);

            if (chunkData && typeof chunkData === "object") {
              const choices = chunkData.choices || [];
              if (choices.length > 0) {
                const delta = choices[0].delta || {};
                if (delta.content) {
                  accumulatedContent += delta.content;
                }
              }
              // Capture usage from the final chunk (sent by OpenRouter before [DONE])
              if (chunkData.usage) {
                streamUsage = chunkData.usage;
              }
            }

            res.write(`data: ${payload}\n\n`);
          } catch (e) {
            console.warn(`BACKEND [ID: ${requestId}]: Invalid JSON in stream.`);
          }
        }
      }
    });

    response.data.on("end", () => {
      // Use real usage from the final chunk if available, otherwise estimate
      const inputTokens =
        streamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(openaiReq));
      const outputTokens =
        streamUsage?.completion_tokens ?? estimateTokens(accumulatedContent);
      const cacheWriteTokens =
        streamUsage?.prompt_tokens_details?.cache_creation_input_tokens ?? 0;
      const cacheReadTokens =
        streamUsage?.prompt_tokens_details?.cached_tokens ?? 0;
      logRequestEnd(
        requestId,
        true,
        inputTokens,
        outputTokens,
        null,
        accumulatedContent,
        apiKey,
        cacheWriteTokens,
        cacheReadTokens,
      );
      res.end();
    });

    response.data.on("error", (error) => {
      console.error(`BACKEND [ID: ${requestId}]: Stream error:`, error);
      const errorResponse = {
        error: {
          message: `Error ${response.status}: ${response.data.statusMessage}`,
          type: "server_error",
          code: 500,
        },
      };
      res.write(`data: ${JSON.stringify(errorResponse)}\n\ndata: [DONE]\n\n`);
      logError(requestId, error.name, error.message, error.stack);
      logRequestEnd(requestId, false, 0, 0, error.message);
      res.end();
    });
  } catch (error) {
    console.error(`BACKEND [ID: ${requestId}]: Stream error:`, error);

    const errorResponse = {
      error: {
        message: `Error 500: Unknown error`,
        type: "server_error",
        code: 500,
      },
    };
    res.write(`data: ${JSON.stringify(errorResponse)}\n\ndata: [DONE]\n\n`);
    logError(requestId, error.name || "Error", error.message, error.stack);
    logRequestEnd(requestId, false, 0, 0, error.message);
    res.end();
  }
}

async function makeBackendRequest(
  requestId,
  openaiReq,
  modelName,
  apiKey,
  cacheDepth = -1,
) {
  const endpointInfo = getEndpointForModel(modelName);

  if (!endpointInfo) {
    const error = new Error("Can't find the model you're looking for.");
    error.statusCode = 404;
    throw error;
  }

  const { url: backendUrl, token: backendToken, actualModel } = endpointInfo;
  const fullUrl = `${backendUrl}/chat/completions`;

  try {
    let messages = openaiReq.messages || [];

    // Apply Claude prompt caching if the target model is Claude and caching is enabled
    if (isClaudeModel(actualModel) && cacheDepth !== -1) {
      messages = applyClaudePromptCaching(messages, cacheDepth);
      console.log(
        `Prompt caching applied (depth=${cacheDepth}): ${
          messages.filter((m) => {
            const content = m.content;
            if (Array.isArray(content))
              return content.some((b) => b.cache_control);
            return false;
          }).length
        } message(s) marked for caching`,
      );
    }

    const data = {
      model: actualModel,
      stream: false,
      messages,
      max_tokens: openaiReq.max_tokens,
      temperature: openaiReq.temperature,
      top_p: openaiReq.top_p,
      tools: openaiReq.tools,
      tool_choice: openaiReq.tool_choice,
    };

    // Remove undefined values
    Object.keys(data).forEach((key) => {
      if (data[key] === undefined || data[key] === null) {
        delete data[key];
      }
    });

    const response = await axios({
      method: "post",
      url: fullUrl,
      headers: {
        Authorization: `Bearer ${backendToken}`,
        "Content-Type": "application/json",
      },
      data,
      timeout: 180000,
    });

    if (response.status !== 200) {
      console.error(`BACKEND [ID: ${requestId}]:`, response.data);
      const error = new Error(
        `Error ${response.status}: ${response.data.statusMessage}`,
      );
      error.statusCode = response.status;
      throw error;
    }

    const responseData = response.data;
    const content = responseData.choices?.[0]?.message?.content || "";
    const usage = responseData.usage || {};
    const inputTokens =
      usage.prompt_tokens ?? estimateTokens(JSON.stringify(openaiReq));
    const outputTokens = usage.completion_tokens ?? estimateTokens(content);
    const cacheWriteTokens =
      usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;

    logRequestEnd(
      requestId,
      true,
      inputTokens,
      outputTokens,
      null,
      content,
      apiKey,
      cacheWriteTokens,
      cacheReadTokens,
    );

    return responseData;
  } catch (error) {
    console.error(`BACKEND [ID: ${requestId}]: Error:`, error.message);
    logError(requestId, error.name || "Error", error.message, error.stack);
    logRequestEnd(requestId, false, 0, 0, error.message);
    throw error;
  }
}

export default router;
