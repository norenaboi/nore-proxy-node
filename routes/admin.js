import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyMasterKey } from '../middleware/auth.js';
import apiKeyManager from '../services/apiKeyManager.js';
import logManager from '../services/logManager.js';
import Config from '../config/index.js';
import { loadModelsFromFile } from '../utils/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Get admin usage data
router.get('/admin/usage-data', verifyMasterKey, async (req, res) => {
  const allApiKeys = apiKeyManager.keys;
  const dashboardData = [];

  for (const apiKey of Object.keys(allApiKeys)) {
    const stats = apiKeyManager.getUsageStats(apiKey);
    dashboardData.push({
      name: apiKeyManager.getKeyName(apiKey),
      api_key: apiKey.length > 5 ? apiKey.substring(0, 5) + '...' : apiKey,
      total_requests: stats.total_requests,
      daily_requests: stats.daily_requests || 0,
      total_input_tokens: stats.total_input_tokens || 0,
      total_output_tokens: stats.total_output_tokens || 0,
      daily_input_tokens: stats.daily_input_tokens || 0,
      daily_output_tokens: stats.daily_output_tokens || 0
    });
  }

  // Sort by daily requests
  dashboardData.sort((a, b) => b.daily_requests - a.daily_requests);

  // Get recent logs
  const logs = logManager.readRequestLogs(100);

  const formattedLogs = logs
    .filter(log => log.type === 'request_end' && log.status === 'success')
    .map(log => {
      const apiKey = log.api_key || 'Unknown';
      return {
        timestamp: log.timestamp || 0,
        request_id: log.request_id || '',
        name: apiKey !== 'Unknown' ? apiKeyManager.getKeyName(apiKey) : 'Unknown',
        api_key: apiKey.length > 5 ? apiKey.substring(0, 5) + '...' : apiKey,
        model: log.model || 'Unknown',
        input_tokens: log.input_tokens || 0,
        output_tokens: log.output_tokens || 0,
        total_tokens: (log.input_tokens || 0) + (log.output_tokens || 0),
        duration: log.duration || 0
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 50);

  const totals = {
    total_api_keys: Object.keys(allApiKeys).length,
    total_requests: dashboardData.reduce((sum, d) => sum + d.total_requests, 0),
    daily_requests: dashboardData.reduce((sum, d) => sum + d.daily_requests, 0),
    total_input_tokens: dashboardData.reduce((sum, d) => sum + d.total_input_tokens, 0),
    total_output_tokens: dashboardData.reduce((sum, d) => sum + d.total_output_tokens, 0),
    daily_input_tokens: dashboardData.reduce((sum, d) => sum + d.daily_input_tokens, 0),
    daily_output_tokens: dashboardData.reduce((sum, d) => sum + d.daily_output_tokens, 0)
  };

  res.json({
    summary: totals,
    api_keys: dashboardData,
    recent_logs: formattedLogs
  });
});

// Get all API keys
router.get('/admin/keys', verifyMasterKey, async (req, res) => {
  try {
    const keys = apiKeyManager.getKeys();
    res.json({ keys });
  } catch (error) {
    console.error('Error loading keys:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add new API key
router.post('/admin/keys/add', verifyMasterKey, async (req, res) => {
  try {
    const apiKey = (req.body.api_key || '').trim();
    const name = (req.body.name || '').trim();

    if (!apiKey || !name) {
      return res.status(400).json({ error: 'API key and name are required' });
    }

    if (apiKeyManager.keys[apiKey]) {
      return res.status(400).json({ error: 'API key already exists' });
    }

    apiKeyManager.addKey(apiKey, name);
    console.log(`Added new API key: ${name}`);

    res.json({ message: 'API key added successfully' });
  } catch (error) {
    console.error('Error adding key:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update API key
router.put('/admin/keys/update', verifyMasterKey, async (req, res) => {
  try {
    const newName = (req.body.name || '').trim();
    const apiKey = (req.body.api_key || '').trim();
    const rpd = req.body.rpd;
    const active = req.body.active;

    if (!newName) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!rpd) {
      return res.status(400).json({ error: 'RPD is required' });
    }

    apiKeyManager.updateKey(apiKey, newName, rpd, active);
    res.json({ message: 'API key updated successfully' });
  } catch (error) {
    console.error('Error updating key:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Delete API key
router.delete('/admin/keys/delete', verifyMasterKey, async (req, res) => {
  try {
    const apiKey = (req.body.api_key || '').trim();

    apiKeyManager.removeKey(apiKey);
    console.log(`Deleted API key: ${apiKey}`);

    res.json({ message: 'API key deleted successfully' });
  } catch (error) {
    console.error('Error deleting key:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reload configuration
router.post('/admin/reload', verifyMasterKey, async (req, res) => {
  Config.reload();
  apiKeyManager.loadKeys();
  loadModelsFromFile();
  apiKeyManager.resetDaily();

  res.json({ status: 'success', message: 'Configuration, keys and models reloaded.' });
});

export default router;