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

/*
    GET for logs in database
*/

// Get logs
router.get('/api/logs', verifyMasterKey, async (req, res) => {
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

/*
    GET PUT POST DELETE for API keys in database
*/

// Get all API keys
router.get('/api/keys', verifyMasterKey, async (req, res) => {
  try {
    const keys = apiKeyManager.getKeys(); 
    res.json({ keys });
  } catch (error) {
    console.error('Error loading keys:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add new API key
router.post('/api/keys', verifyMasterKey, async (req, res) => {
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
router.put('/api/keys', verifyMasterKey, async (req, res) => {
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
router.delete('/api/keys', verifyMasterKey, async (req, res) => {
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

/*
    GET PUT POST DELETE for allowed_models.txt
*/

// Get all models
router.get('/api/models', verifyMasterKey, async (req, res) => {
  try {
    const modelsPath = path.join(__dirname, '../allowed_models.txt');
    const content = fs.existsSync(modelsPath) ? fs.readFileSync(modelsPath, 'utf-8') : '';
    const models = content
      .split('\n')
      .map(line => line.replace(/\r/g, '').trim())  // Remove \r and trim
      .filter(line => line && !line.startsWith('#'));
    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add model
router.post('/api/models', verifyMasterKey, async (req, res) => {
  try {
    const model = (req.body.model || '').trim();
    if (!model) return res.status(400).json({ error: 'Model name required' });
    
    const modelsPath = path.join(__dirname, '../allowed_models.txt');
    const content = fs.existsSync(modelsPath) ? fs.readFileSync(modelsPath, 'utf-8') : '';
    const models = content.split('\n').filter(line => line.trim());
    
    if (models.includes(model)) return res.status(400).json({ error: 'Model already exists' });
    
    models.push(model);
    fs.writeFileSync(modelsPath, models.join('\n'));
    loadModelsFromFile();
    res.json({ message: 'Model added' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update model
router.put('/api/models', verifyMasterKey, async (req, res) => {
  try {
    const oldModel = (req.body.oldModel || '').replace(/\r/g, '').trim();
    const newModel = (req.body.newModel || '').replace(/\r/g, '').trim();
    
    if (!oldModel || !newModel) {
      return res.status(400).json({ error: 'Both model names required' });
    }
    
    const modelsPath = path.join(__dirname, '../allowed_models.txt');
    const content = fs.readFileSync(modelsPath, 'utf-8');
    const models = content.split('\n').map(line => {
      const cleanLine = line.replace(/\r/g, '').trim();
      return cleanLine === oldModel ? newModel : cleanLine;
    });
    
    fs.writeFileSync(modelsPath, models.join('\n'));
    loadModelsFromFile();
    res.json({ message: 'Model updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete model
router.delete('/api/models', verifyMasterKey, async (req, res) => {
  try {
    const model = (req.body.model || '').replace(/\r/g, '').trim();
    if (!model) return res.status(400).json({ error: 'Model name required' });
    
    const modelsPath = path.join(__dirname, '../allowed_models.txt');
    const content = fs.readFileSync(modelsPath, 'utf-8');
    const models = content
      .split('\n')
      .map(line => line.replace(/\r/g, '').trim())
      .filter(line => line !== model);
    
    fs.writeFileSync(modelsPath, models.join('\n'));
    loadModelsFromFile();
    res.json({ message: 'Model deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/*
    GET PUT POST DELETE for endpoints.txt
*/

// Get all endpoints
router.get('/api/endpoints', verifyMasterKey, async (req, res) => {
  try {
    const endpointsPath = path.join(__dirname, '../endpoints.txt');
    const content = fs.existsSync(endpointsPath) ? fs.readFileSync(endpointsPath, 'utf-8') : '';
    const lines = content.split('\n').filter(line => line.trim());
    
    const endpoints = [];
    for (let i = 0; i < lines.length; i += 2) {
      const urlMatch = lines[i]?.match(/^V(\d+)_URL=(.+)$/);
      const tokenMatch = lines[i + 1]?.match(/^V(\d+)_TOKEN=(.+)$/);
      if (urlMatch && tokenMatch && urlMatch[1] === tokenMatch[1]) {
        endpoints.push({ index: parseInt(urlMatch[1]), url: urlMatch[2], token: tokenMatch[2] });
      }
    }
    
    res.json({ endpoints });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add endpoint
router.post('/api/endpoints', verifyMasterKey, async (req, res) => {
  try {
    const url = (req.body.url || '').trim();
    const token = (req.body.token || '').trim();
    if (!url || !token) return res.status(400).json({ error: 'URL and token required' });
    
    const endpointsPath = path.join(__dirname, '../endpoints.txt');
    const content = fs.existsSync(endpointsPath) ? fs.readFileSync(endpointsPath, 'utf-8') : '';
    const lines = content.split('\n').filter(line => line.trim());
    
    let maxIndex = 0;
    for (const line of lines) {
      const match = line.match(/^V(\d+)_/);
      if (match) maxIndex = Math.max(maxIndex, parseInt(match[1]));
    }
    
    const newIndex = maxIndex + 1;
    const newContent = content.trim() + (content.trim() ? '\n\n' : '') + `V${newIndex}_URL=${url}\nV${newIndex}_TOKEN=${token}`;
    fs.writeFileSync(endpointsPath, newContent);
    res.json({ message: 'Endpoint added', index: newIndex });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update endpoint
router.put('/api/endpoints', verifyMasterKey, async (req, res) => {
  try {
    const index = req.body.index;
    const url = (req.body.url || '').trim();
    const token = (req.body.token || '').trim();
    if (!index || !url || !token) return res.status(400).json({ error: 'Index, URL and token required' });
    
    const endpointsPath = path.join(__dirname, '../endpoints.txt');
    const content = fs.readFileSync(endpointsPath, 'utf-8');
    
    let updated = content
      .replace(new RegExp(`^V${index}_URL=.+$`, 'm'), `V${index}_URL=${url}`)
      .replace(new RegExp(`^V${index}_TOKEN=.+$`, 'm'), `V${index}_TOKEN=${token}`);
    
    if (updated === content) return res.status(404).json({ error: 'Endpoint not found' });
    
    fs.writeFileSync(endpointsPath, updated);
    res.json({ message: 'Endpoint updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete endpoint
router.delete('/api/endpoints', verifyMasterKey, async (req, res) => {
  try {
    const index = req.body.index;
    if (!index) return res.status(400).json({ error: 'Index required' });
    
    const endpointsPath = path.join(__dirname, '../endpoints.txt');
    const content = fs.readFileSync(endpointsPath, 'utf-8');
    
    const lines = content.split('\n').filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith(`V${index}_URL=`) && !trimmed.startsWith(`V${index}_TOKEN=`);
    });
    
    fs.writeFileSync(endpointsPath, lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
    res.json({ message: 'Endpoint deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/*
    POST for reloading and refreshing everything
*/

// Reload configuration
router.post('/api/reload', verifyMasterKey, async (req, res) => {
  Config.reload();
  apiKeyManager.loadKeys();
  loadModelsFromFile();
  apiKeyManager.resetDaily();

  res.json({ status: 'success', message: 'Configuration, keys and models reloaded.' });
});

export default router;