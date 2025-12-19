import logManager from '../services/logManager.js';
import realtimeStats from '../services/realtimeStats.js';
import requestDetailsStorage from '../services/requestDetailsStorage.js';
import performanceMonitor from '../services/performanceMonitor.js';
import {
  requestCount,
  requestDuration,
  tokenUsage,
  errorCount
} from '../services/metricsService.js';

export function logRequestStart(requestId, model, params, messages = [], apiKey = null) {
  const requestInfo = {
    id: requestId,
    model,
    start_time: Date.now() / 1000,
    status: 'active',
    params,
    messages: messages || [],
    api_key: apiKey
  };

  realtimeStats.activeRequests.set(requestId, requestInfo);

  const logEntry = {
    type: 'request_start',
    timestamp: Date.now() / 1000,
    request_id: requestId,
    model,
    params,
    api_key: apiKey
  };

  logManager.writeRequestLog(logEntry);
}

export function logRequestEnd(
  requestId,
  success,
  inputTokens = 0,
  outputTokens = 0,
  error = null,
  responseContent = '',
  apiKey = null
) {
  if (!realtimeStats.activeRequests.has(requestId)) {
    return;
  }

  const req = realtimeStats.activeRequests.get(requestId);
  const duration = Date.now() / 1000 - req.start_time;

  req.status = success ? 'success' : 'failed';
  req.duration = duration;
  req.input_tokens = inputTokens;
  req.output_tokens = outputTokens;
  req.error = error;
  req.end_time = Date.now() / 1000;
  req.response_content = responseContent;

  realtimeStats.addRecentRequest({ ...req });

  const model = req.model;
  const stats = realtimeStats.getModelUsage(model);
  stats.requests++;
  if (success) {
    stats.tokens += inputTokens + outputTokens;
  } else {
    stats.errors++;
  }

  performanceMonitor.recordRequest(model, duration, success);

  // Prometheus metrics
  requestCount.labels({ model, status: success ? 'success' : 'failed', type: 'chat' }).inc();
  requestDuration.labels({ model, type: 'chat' }).observe(duration);
  tokenUsage.labels({ model, token_type: 'input' }).inc(inputTokens);
  tokenUsage.labels({ model, token_type: 'output' }).inc(outputTokens);

  // Store request details
  const details = {
    request_id: requestId,
    timestamp: req.start_time,
    model,
    status: success ? 'success' : 'failed',
    duration,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    error,
    request_params: req.params || {},
    request_messages: req.messages || [],
    response_content: responseContent.substring(0, 5000),
    headers: {}
  };
  requestDetailsStorage.add(details);

  // Write to log file
  const logEntry = {
    type: 'request_end',
    timestamp: Date.now() / 1000,
    request_id: requestId,
    model,
    status: success ? 'success' : 'failed',
    duration,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    error,
    params: req.params || {},
    api_key: apiKey || req.api_key
  };
  logManager.writeRequestLog(logEntry);

  realtimeStats.activeRequests.delete(requestId);
}

export function logError(requestId, errorType, errorMessage, stackTrace = '') {
  const errorData = {
    timestamp: Date.now() / 1000,
    request_id: requestId,
    error_type: errorType,
    error_message: errorMessage,
    stack_trace: stackTrace
  };

  realtimeStats.addRecentError(errorData);

  // Prometheus
  const model = realtimeStats.activeRequests.get(requestId)?.model || 'unknown';
  errorCount.labels({ error_type: errorType, model }).inc();

  logManager.writeErrorLog(errorData);
}