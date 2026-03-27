const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://api.pipedrive.com/v1';

// CORS para todas las rutas
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'x-pipedrive-token, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Carga TODOS los deals de un pipeline paginando automáticamente
app.get('/pipelines/:id/deals/all', async (req, res) => {
  try {
    const { id } = req.params;
    const token = req.headers['x-pipedrive-token'];
    if (!token) return res.status(401).json({ error: 'Token no proporcionado' });

    let all = [], start = 0, page = 0;
    while (true) {
      page++;
      const url = `${BASE}/pipelines/${id}/deals?limit=500&start=${start}&status=all_not_deleted&api_token=${token}`;
      console.log(`[Pipeline ${id}] Página ${page}, start=${start}`);
      const response = await fetch(url);
      const data = await response.json();
      const items = data.data || [];
      all = all.concat(items);
      const more = data.additional_data?.pagination?.more_items_in_collection;
      if (!more || items.length === 0) break;
      start += 500;
      if (page > 50) break;
    }

    console.log(`[Pipeline ${id}] Total: ${all.length} deals`);
    res.json({ success: true, data: all, total: all.length });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ruta general para cualquier llamada a Pipedrive
app.get('/pipedrive/*', async (req, res) => {
  try {
    const path = req.path.replace('/pipedrive', '');
    const token = req.headers['x-pipedrive-token'];
    if (!token) return res.status(401).json({ error: 'Token no proporcionado' });

    const params = new URLSearchParams(req.query);
    params.set('api_token', token);

    const url = `${BASE}${path}?${params.toString()}`;
    console.log(`GET ${path}`);

    const response = await fetch(url);
    const data = await response.json();
    res.json(data);

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy APM corriendo en puerto ${PORT}`);
});
