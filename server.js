const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://api.pipedrive.com/v1';

app.use(cors());

// ============================================
// ENDPOINT: Proxy de Pipedrive (existente)
// ============================================
app.get('/pipedrive/*', async (req, res) => {
  try {
    const pathParam = req.path.replace('/pipedrive', '');
    const token = req.headers['x-pipedrive-token'];
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
    
    // Verificar si el archivo existe
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Data not available yet',
        message: 'Pipedrive sync is running. Try again in a few minutes.'
      });
    }

    // Leer el archivo JSON
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
// ENDPOINT: Health check (existente)
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
