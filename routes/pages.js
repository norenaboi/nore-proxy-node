import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

function serveHtml(res, filename) {
  const htmlPath = path.join(__dirname, '..', 'html', filename);
  const errorPath = path.join(__dirname, '..', 'html', '404.html');

  if (fs.existsSync(htmlPath)) {
    const content = fs.readFileSync(htmlPath, 'utf-8');
    res.type('html').send(content);
  } else if (fs.existsSync(errorPath)) {
    const errorContent = fs.readFileSync(errorPath, 'utf-8');
    res.status(404).type('html').send(errorContent);
  } else {
    res.status(404).send('Page not found');
  }
}

router.get('/', (req, res) => {
  serveHtml(res, 'index.html');
});

router.get('/v1', (req, res) => {
  res.redirect('/');
});

router.get('/models', (req, res) => {
  serveHtml(res, 'models.html');
});

router.get('/usage', (req, res) => {
  serveHtml(res, 'user_usage.html');
});

router.get('/admin/login', (req, res) => {
  serveHtml(res, 'login_admin.html');
});

router.get('/admin/usage', (req, res) => {
  serveHtml(res, 'admin_usage.html');
});

router.get('/admin/manager', (req, res) => {
  serveHtml(res, 'admin_manager.html');
});

export default router;