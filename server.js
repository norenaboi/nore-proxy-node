import express from "express";
import cors from "cors";
import helmet from "helmet";
import crypto from "crypto";
import Config from "./config/index.js";
import { loadModelsFromFile, MODEL_REGISTRY } from "./utils/helpers.js";
import apiKeyManager from "./services/apiKeyManager.js";
import realtimeStats from "./services/realtimeStats.js";
import {
  activeRequestsGauge,
  modelRegistryGauge,
} from "./services/metricsService.js";
import prometheusClient from "./services/metricsService.js";

// Import routes
import rateLimiter from "./middleware/rateLimiter.js";
import chatRoutes from "./routes/chat.js";
import modelsRoutes from "./routes/models.js";
import statsRoutes, { setStartupTime } from "./routes/stats.js";
import adminRoutes from "./routes/admin.js";
import pagesRoutes from "./routes/pages.js";

const app = express();

// Middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // All HTML pages use inline <script> and <style> tags
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net",
          "https://static.cloudflareinsights.com",
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net",
          "https://fonts.googleapis.com",
        ],
        fontSrc: [
          "'self'",
          "https://cdnjs.cloudflare.com",
          "https://fonts.gstatic.com",
        ],
        imgSrc: ["'self'", "data:"],
        // Allow inline event handlers (onsubmit, onclick, etc.) used throughout the HTML pages
        scriptSrcAttr: ["'unsafe-inline'"],
        connectSrc: ["'self'", "https://cloudflareinsights.com"],
      },
    },
  }),
);
// Allow CORS_ORIGIN env var to restrict origins; defaults to '*' for open proxy use
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

// Parse cookies without an extra dependency
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      req.cookies[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim(),
      );
    }
  }
  next();
});

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

  // Start rate limiter cleanup
  rateLimiter.startCleanup();

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

      // Update Prometheus gauges
      activeRequestsGauge.set(realtimeStats.activeRequests.size);
      modelRegistryGauge.set(Object.keys(MODEL_REGISTRY).length);

      // Cleanup complete (debug: active requests = realtimeStats.activeRequests.size)
    } catch (error) {
      console.error("Error in cleanup task:", error);
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

// Prometheus metrics endpoint — protected by master key
app.get("/metrics", async (req, res) => {
  const provided = req.headers.authorization || "";
  const expected = Config.MASTER_KEY;
  let authorized = false;
  try {
    authorized =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch (_) {}
  if (!authorized) return res.status(403).end("Forbidden");

  try {
    res.set("Content-Type", prometheusClient.register.contentType);
    const metrics = await prometheusClient.register.metrics();
    res.end(metrics);
  } catch (error) {
    console.error("Metrics error:", error);
    res.status(500).end("Internal server error");
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler — never leak raw exception messages to clients
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.statusCode || 500).json({
    error: err.statusCode ? err.message : "Internal server error",
  });
});

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
  SHUTTING_DOWN = true;

  stopBackgroundTasks();

  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error(
      "Could not close connections in time, forcefully shutting down",
    );
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start server
const server = app.listen(Config.PORT, Config.HOST, async () => {
  await initialize();

  const datetime = new Date().toISOString().replace("T", " ").slice(0, 19);

  console.log("\n" + "=".repeat(60));
  console.log("=".repeat(20) + "     NORE PROXY     " + "=".repeat(20));
  console.log("=".repeat(60));
  console.log(`  Launched at:    ${datetime}`);
  console.log(`  Port:           ${Config.PORT}`);
  console.log(
    `  Rate Limits:    ${Config.RPM_DEFAULT} RPM / ${Config.RPD_DEFAULT} RPD`,
  );
  console.log(
    `  Endpoints:      Configured ${Object.keys(Config.ENDPOINTS).length} endpoints`,
  );
  console.log(
    `  Models:         Loaded ${Object.keys(MODEL_REGISTRY).length} models`,
  );
  console.log(`  Main Page:      http://localhost:${Config.PORT}`);
  console.log(`  Login:          http://localhost:${Config.PORT}/admin/login`);
  console.log(`  API Base URL:   http://localhost:${Config.PORT}/v1`);
  console.log("=".repeat(60));
  console.log("=".repeat(60));
  console.log(" ".repeat(60));
});

export default app;
