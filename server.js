const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://api.pipedrive.com/v1';
app.use(cors());
app.use(express.json());

// ============================================
// ENDPOINT: Proxy de Pipedrive
// ============================================
app.get('/pipedrive/*', async (req, res) => {
  try {
    const pathParam = req.path.replace('/pipedrive', '');
    const token = req.headers['x-pipedrive-token'] || process.env.PIPEDRIVE_TOKEN;
    if (!token) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }
    const params = new URLSearchParams(req.query);
    params.set('api_token', token);
    const url = `${BASE}${pathParam}?${params.toString()}`;
    console.log(`[${new Date().toISOString()}] GET ${pathParam}`);
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ENDPOINT: Datos sincronizados de Pipedrive
// ============================================
app.get('/api/pipedrive', (req, res) => {
  try {
    const filePath = '/tmp/pipedrive_data.json';
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Data not available yet',
        message: 'Pipedrive sync is running. Try again in a few minutes.'
      });
    }
    const data = fs.readFileSync(filePath, 'utf8');
    const jsonData = JSON.parse(data);
    res.json(jsonData);
  } catch (err) {
    console.error('Error reading Pipedrive data:', err.message);
    res.status(500).json({
      error: err.message,
      message: 'Error reading Pipedrive data file'
    });
  }
});

// ============================================
// ENDPOINT: Proxy de HubSpot
// ============================================
app.use('/hubspot', async (req, res) => {
  const token = req.headers['x-hubspot-token'] || process.env.HUBSPOT_TOKEN;
  try {
    const cleanPath = req.path;
    const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
    const url = 'https://api.hubapi.com' + cleanPath + query;
    console.log(`[HubSpot] ${req.method} ${url}`);
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error('[HubSpot] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// ENDPOINT: Health check
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// Iniciar servidor
// ============================================
app.listen(PORT, () => {
  console.log(`Proxy APM corriendo en puerto ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Pipedrive data: http://localhost:${PORT}/api/pipedrive`);
});
