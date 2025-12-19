import client from 'prom-client';

// Create metrics
const requestCount = new client.Counter({
  name: 'requests_total',
  help: 'Total number of requests',
  labelNames: ['model', 'status', 'type']
});

const requestDuration = new client.Histogram({
  name: 'request_duration_seconds',
  help: 'Request duration in seconds',
  labelNames: ['model', 'type'],
  buckets: [0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0]
});

const activeRequestsGauge = new client.Gauge({
  name: 'active_requests',
  help: 'Number of active requests'
});

const tokenUsage = new client.Counter({
  name: 'tokens_total',
  help: 'Total number of tokens used',
  labelNames: ['model', 'token_type']
});

const errorCount = new client.Counter({
  name: 'errors_total',
  help: 'Total number of errors',
  labelNames: ['error_type', 'model']
});

const modelRegistryGauge = new client.Gauge({
  name: 'models_registered',
  help: 'Number of registered models'
});

export {
  requestCount,
  requestDuration,
  activeRequestsGauge,
  tokenUsage,
  errorCount,
  modelRegistryGauge
};

export default client;