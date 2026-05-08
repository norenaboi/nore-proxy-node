import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateSession } from "../services/sessionManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

function requireSession(req, res, next) {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      cookies[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim(),
      );
    }
  }
  if (!validateSession(cookies.adminSession)) {
    return res.redirect("/admin/login");
  }
  next();
}

function serveHtml(res, filename) {
  const htmlPath = path.join(__dirname, "..", "html", filename);
  const errorPath = path.join(__dirname, "..", "html", "404.html");

  if (fs.existsSync(htmlPath)) {
    const content = fs.readFileSync(htmlPath, "utf-8");
    res.type("html").send(content);
  } else if (fs.existsSync(errorPath)) {
    const errorContent = fs.readFileSync(errorPath, "utf-8");
    res.status(404).type("html").send(errorContent);
  } else {
    res.status(404).send("Page not found");
  }
}

router.get("/favicon.ico", (req, res) => {
  const faviconPath = path.join(__dirname, "..", "html", "favicon.ico");
  res.sendFile(faviconPath);
});

router.get("/", (req, res) => {
  serveHtml(res, "index.html");
});

router.get("/v1", (req, res) => {
  res.redirect("/");
});

router.get("/models", (req, res) => {
  serveHtml(res, "display.html");
});

router.get("/usage", (req, res) => {
  serveHtml(res, "usage.html");
});

router.get("/admin", (req, res) => {
  res.redirect("/admin/login");
});

router.get("/admin/login", (req, res) => {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      cookies[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim(),
      );
    }
  }
  if (validateSession(cookies.adminSession)) {
    return res.redirect("/admin/dashboard");
  }
  serveHtml(res, "login.html");
});

router.get("/admin/dashboard", requireSession, (req, res) => {
  serveHtml(res, "dashboard.html");
});

router.get("/admin/keys", requireSession, (req, res) => {
  serveHtml(res, "keys.html");
});

router.get("/admin/models", requireSession, (req, res) => {
  serveHtml(res, "models.html");
});

router.get("/admin/endpoints", requireSession, (req, res) => {
  serveHtml(res, "endpoints.html");
});

router.get("/admin/settings", requireSession, (req, res) => {
  serveHtml(res, "settings.html");
});

export default router;
