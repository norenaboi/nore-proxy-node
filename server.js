import express from 'express';
import cors from 'cors';
import Config from './config/index.js';
import { loadModelsFromFile, MODEL_REGISTRY } from './utils/helpers.js';
import apiKeyManager from './services/apiKeyManager.js';
import realtimeStats from './services/realtimeStats.js';
import logManager from './services/logManager.js';
import { activeRequestsGauge, modelRegistryGauge } from './services/metricsService.js';
import prometheusClient from './services/metricsService.js';

// Import routes
import chatRoutes from './routes/chat.js';
import modelsRoutes from './routes/models.js';
import statsRoutes, { setStartupTime } from './routes/stats.js';
import adminRoutes from './routes/admin.js';
import pagesRoutes from './routes/pages.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Global state
let SHUTTING_DOWN = false;
const startupTime = Date.now() / 1000;
setStartupTime(startupTime);

// Background tasks
const backgroundTasks = new Set();

// Initialize
async function initialize() {
  // Load endpoints from environment
  Config.loadEndpoints();

  // Load models from file
  loadModelsFromFile();
  console.log(`Loaded ${Object.keys(MODEL_REGISTRY).length} models`);

  // Start background tasks
  startBackgroundTasks();
}

function startBackgroundTasks() {
  // Daily reset task - check every hour and reset at midnight
  const dailyResetTask = setInterval(() => {
    if (SHUTTING_DOWN) return;
    
    // Check if we need to reset (new day)
    apiKeyManager.resetDaily();
  }, 3600000); // Check every hour

  backgroundTasks.add(dailyResetTask);

  // Cleanup task
  const cleanupTask = setInterval(() => {
    if (SHUTTING_DOWN) return;

    try {
      realtimeStats.cleanupOldRequests();
      logManager.checkAndRotate();

      // Update Prometheus gauges
      activeRequestsGauge.set(realtimeStats.activeRequests.size);
      modelRegistryGauge.set(Object.keys(MODEL_REGISTRY).length);

      console.log(`Cleanup task completed. Active requests: ${realtimeStats.activeRequests.size}`);
    } catch (error) {
      console.error('Error in cleanup task:', error);
    }
  }, Config.CLEANUP_INTERVAL * 1000);

  backgroundTasks.add(cleanupTask);
}

function stopBackgroundTasks() {
  console.log(`Stopping ${backgroundTasks.size} background tasks...`);
  for (const task of backgroundTasks) {
    clearInterval(task);
  }
  backgroundTasks.clear();
}

// Routes
app.use(chatRoutes);
app.use(modelsRoutes);
app.use(statsRoutes);
app.use(adminRoutes);
app.use(pagesRoutes);

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', prometheusClient.register.contentType);
    const metrics = await prometheusClient.register.metrics();
    res.end(metrics);
  } catch (error) {
    res.status(500).end(error.message);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Date.now() / 1000 - startupTime,
    active_requests: realtimeStats.activeRequests.size
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
  SHUTTING_DOWN = true;

  stopBackgroundTasks();

  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
const server = app.listen(Config.PORT, Config.HOST, async () => {
  await initialize();

  const datetime = new Date().toISOString().replace('T', ' ').slice(0, 19);
  
  console.log('\n' + '='.repeat(60));
  console.log('='.repeat(20) + '     NORE PROXY     ' + '='.repeat(20));
  console.log('='.repeat(60));
  console.log(`  Launched at:    ${datetime}`);
  console.log(`  Host:           ${Config.HOST}`);
  console.log(`  Port:           ${Config.PORT}`);
  console.log(`  Rate Limits:    ${Config.RPM_DEFAULT} RPM / ${Config.RPD_DEFAULT} RPD`);
  console.log(`  Endpoints:      ${Object.keys(Config.ENDPOINTS).length} configured`);
  console.log(`  Main Page:      http://localhost:${Config.PORT}`);
  console.log(`  Login:          http://localhost:${Config.PORT}/admin/login`);
  console.log(`  API Base URL:   http://localhost:${Config.PORT}/v1`);
  console.log('='.repeat(60));
  console.log('='.repeat(60));
  console.log(' '.repeat(60));
});

export default app;