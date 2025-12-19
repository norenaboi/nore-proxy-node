import express from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { verifyApiKey } from '../middleware/auth.js';
import apiKeyManager from '../services/apiKeyManager.js';
import rateLimiter from '../middleware/rateLimiter.js';
import { logRequestStart, logRequestEnd, logError } from '../utils/logging.js';
import { MODEL_REGISTRY, getEndpointForModel, estimateTokens, resolveModelName } from '../utils/helpers.js';

const router = express.Router();

router.post('/v1/chat/completions', verifyApiKey, async (req, res) => {
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

  // Validate model
  const modelInfo = MODEL_REGISTRY[modelName];
  if (!modelInfo) {
    return res.status(404).json({ error: `Model '${modelName}' not found.` });
  }

  // Remove unwanted parameters
  const paramsToExclude = ['frequency_penalty', 'presence_penalty', 'top_p'];
  for (const param of paramsToExclude) {
    delete openaiReq[param];
  }

  // Log request start
  const requestParams = {
    temperature: openaiReq.temperature,
    max_tokens: openaiReq.max_tokens,
    streaming: isStreaming
  };
  const messages = openaiReq.messages || [];
  logRequestStart(requestId, modelName, requestParams, messages, apiKey);

  try {
    if (isStreaming) {
      await streamFromBackend(req, res, requestId, openaiReq, modelName, apiKey);
    } else {
      const responseData = await makeBackendRequest(requestId, openaiReq, modelName, apiKey);
      res.json(responseData);
    }
  } catch (error) {
    logRequestEnd(requestId, false, 0, 0, error.message);
    console.error(`API [ID: ${requestId}]: Exception:`, error);
    res.status(500).json({
      error: 'Error: Encountered an error. Please try again later or contact the admin.'
    });
  }
});

async function streamFromBackend(req, res, requestId, openaiReq, modelName, apiKey) {
  let accumulatedContent = '';

  const endpointInfo = getEndpointForModel(modelName);

  if (!endpointInfo) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const errorResponse = {
      error: {
        message: "Error 404: Can't find the model you're looking for.",
        type: 'server_error',
        code: 404
      }
    };
    res.write(`data: ${JSON.stringify(errorResponse)}\n\ndata: [DONE]\n\n`);
    res.end();
    return;
  }

  const { url: backendUrl, token: backendToken, actualModel } = endpointInfo;
  const fullUrl = `${backendUrl}/chat/completions`;

  console.log(`Request model: ${modelName}`);
  console.log(`Actual model: ${actualModel}`);
  console.log(`Endpoint URL: ${fullUrl}`);

  // Set streaming headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const data = {
      model: actualModel,
      stream: true,
      messages: openaiReq.messages || [],
      max_tokens: openaiReq.max_tokens
    };

    // Remove undefined values
    Object.keys(data).forEach(key => {
      if (data[key] === undefined || data[key] === null) {
        delete data[key];
      }
    });

    const response = await axios({
      method: 'post',
      url: fullUrl,
      headers: {
        'Authorization': `Bearer ${backendToken}`,
        'Content-Type': 'application/json'
      },
      data,
      responseType: 'stream',
      timeout: 180000
    });

    if (response.status !== 200) {
      const errorResponse = {
        error: {
          message: `Error ${response.status}: Encountered an error. Please try again later or contact the admin.`,
          type: 'server_error',
          code: response.status
        }
      };
      res.write(`data: ${JSON.stringify(errorResponse)}\n\ndata: [DONE]\n\n`);
      res.end();
      return;
    }

    let buffer = '';

    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const payload = trimmed.slice(6).trim();

          if (payload === '[DONE]') {
            res.write('data: [DONE]\n\n');
            return;
          }

          try {
            const chunkData = JSON.parse(payload);

            if (chunkData && typeof chunkData === 'object') {
              const choices = chunkData.choices || [];
              if (choices.length > 0) {
                const delta = choices[0].delta || {};
                if (delta.content) {
                  accumulatedContent += delta.content;
                }
              }
            }

            res.write(`data: ${payload}\n\n`);
          } catch (e) {
            console.warn(`BACKEND [ID: ${requestId}]: Invalid JSON in stream.`);
          }
        }
      }
    });

    response.data.on('end', () => {
      // Log successful completion
      const inputTokens = estimateTokens(JSON.stringify(openaiReq));
      const outputTokens = estimateTokens(accumulatedContent);
      logRequestEnd(requestId, true, inputTokens, outputTokens, null, accumulatedContent, apiKey);
      res.end();
    });

    response.data.on('error', (error) => {
      console.error(`BACKEND [ID: ${requestId}]: Stream error:`, error);
      const errorResponse = {
        error: {
          message: 'Encountered an error. Please try again later or contact the admin.',
          type: 'server_error',
          code: 500
        }
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
        message: 'Encountered an error. Please try again later or contact the admin.',
        type: 'server_error',
        code: 500
      }
    };
    res.write(`data: ${JSON.stringify(errorResponse)}\n\ndata: [DONE]\n\n`);
    logError(requestId, error.name || 'Error', error.message, error.stack);
    logRequestEnd(requestId, false, 0, 0, error.message);
    res.end();
  }
}

async function makeBackendRequest(requestId, openaiReq, modelName, apiKey) {
  const endpointInfo = getEndpointForModel(modelName);

  if (!endpointInfo) {
    const error = new Error("Can't find the model you're looking for.");
    error.statusCode = 404;
    throw error;
  }

  const { url: backendUrl, token: backendToken, actualModel } = endpointInfo;
  const fullUrl = `${backendUrl}/chat/completions`;

  console.log(`Request model: ${modelName}`);
  console.log(`Actual model: ${actualModel}`);
  console.log(`Endpoint URL: ${fullUrl}`);

  try {
    const data = {
      model: actualModel,
      stream: false,
      messages: openaiReq.messages || [],
      max_tokens: openaiReq.max_tokens
    };

    // Remove undefined values
    Object.keys(data).forEach(key => {
      if (data[key] === undefined || data[key] === null) {
        delete data[key];
      }
    });

    const response = await axios({
      method: 'post',
      url: fullUrl,
      headers: {
        'Authorization': `Bearer ${backendToken}`,
        'Content-Type': 'application/json'
      },
      data,
      timeout: 180000
    });

    if (response.status !== 200) {
      console.error(`BACKEND [ID: ${requestId}]:`, response.data);
      const error = new Error('Encountered an error. Please try again later or contact the admin.');
      error.statusCode = response.status;
      throw error;
    }

    const responseData = response.data;
    const content = responseData.choices?.[0]?.message?.content || '';
    const inputTokens = estimateTokens(JSON.stringify(openaiReq));
    const outputTokens = estimateTokens(content);

    logRequestEnd(requestId, true, inputTokens, outputTokens, null, content, apiKey);

    return responseData;

  } catch (error) {
    console.error(`BACKEND [ID: ${requestId}]: Error:`, error.message);
    logError(requestId, error.name || 'Error', error.message, error.stack);
    logRequestEnd(requestId, false, 0, 0, error.message);
    throw error;
  }
}

export default router;