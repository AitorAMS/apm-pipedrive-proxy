const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CORS - CRÍTICO PARA EL DASHBOARD
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

app.use(express.json());
app.use(express.static('public'));

// ═══════════════════════════════════════════════════════
// 🔑 CONFIGURACIÓN - Desde variables de entorno
// ═══════════════════════════════════════════════════════
const PIPEDRIVE_API_KEY = process.env.PIPEDRIVE_API_KEY;
const PIPEDRIVE_BASE_URL = 'https://api.pipedrive.com/v1';

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

if (!PIPEDRIVE_API_KEY) console.warn('⚠️ PIPEDRIVE_API_KEY no está configurada');
if (!HUBSPOT_API_KEY) console.warn('⚠️ HUBSPOT_API_KEY no está configurada');

// ═══════════════════════════════════════════════════════
// 📡 FUNCIONES HELPER
// ═══════════════════════════════════════════════════════

/**
 * Fetch con reintentos desde Pipedrive
 */
async function pipedriveRequest(endpoint, options = {}) {
  const url = `${PIPEDRIVE_BASE_URL}${endpoint}${endpoint.includes('?') ? '&' : '?'}api_token=${PIPEDRIVE_API_KEY}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers }
    });
    if (!response.ok) throw new Error(`Pipedrive HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`❌ Pipedrive request failed: ${endpoint}`, error.message);
    throw error;
  }
}

/**
 * Fetch con reintentos desde HubSpot
 */
async function hubspotRequest(endpoint, options = {}) {
  const url = `${HUBSPOT_BASE_URL}${endpoint}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
    if (!response.ok) throw new Error(`HubSpot HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`❌ HubSpot request failed: ${endpoint}`, error.message);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════
// 🏥 HEALTH CHECK
// ═══════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'APM Pipedrive Proxy',
    timestamp: new Date().toISOString(),
    apis: {
      pipedrive: PIPEDRIVE_API_KEY ? '🟢 configured' : '🔴 missing key',
      hubspot: HUBSPOT_API_KEY ? '🟢 configured' : '🔴 missing key'
    }
  });
});

// ═══════════════════════════════════════════════════════
// 📊 ENDPOINT: /api/pipedrive
// Dashboard solicita datos agregados de Pipedrive
// ═══════════════════════════════════════════════════════
app.get('/api/pipedrive', async (req, res) => {
  try {
    if (!PIPEDRIVE_API_KEY) {
      return res.status(401).json({ error: 'PIPEDRIVE_API_KEY not configured' });
    }

    // Obtener deals de los pipelines APM
    const apmPipelines = [1, 2, 3, 4, 8, 9, 13, 17]; // IDs de los pipelines APM
    const allDeals = [];

    for (const pipelineId of apmPipelines) {
      try {
        const data = await pipedriveRequest(`/pipelines/${pipelineId}/deals?limit=500&status=open`);
        if (data.success && data.data) {
          allDeals.push(...data.data);
        }
      } catch (e) {
        console.warn(`⚠️ Could not fetch pipeline ${pipelineId}:`, e.message);
      }
    }

    // Obtener deal fields para enumeraciones
    const fieldsData = await pipedriveRequest('/dealFields?limit=500');
    const fieldMap = {};
    if (fieldsData.success && fieldsData.data) {
      fieldsData.data.forEach(field => {
        if (field.options) {
          field.options.forEach(opt => {
            fieldMap[opt.id] = opt.label;
          });
        }
      });
    }

    res.json({
      success: true,
      summary: {
        totalDeals: allDeals.length,
        pipelines: apmPipelines.length,
        timestamp: new Date().toISOString()
      },
      deals: allDeals,
      fieldMap: fieldMap,
      _hint: 'Use this data for rendering Pipedrive dashboards'
    });

  } catch (error) {
    console.error('❌ /api/pipedrive error:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'Verify PIPEDRIVE_API_KEY is valid and Pipedrive API is accessible'
    });
  }
});

// ═══════════════════════════════════════════════════════
// 📊 ENDPOINT: /api/hubspot
// Dashboard solicita datos agregados de HubSpot
// ═══════════════════════════════════════════════════════
app.get('/api/hubspot', async (req, res) => {
  try {
    if (!HUBSPOT_API_KEY) {
      return res.status(401).json({ error: 'HUBSPOT_API_KEY not configured' });
    }

    // Obtener deals de HubSpot
    const pipelineIds = [
      '866830106',  // APM Acquisition
      '807042859',  // IBERIA: LAS APMs
      '857575213',  // IBERIA: LAS PUDOs
      '821946550',  // IBERIA: ENTERPRISE
      '822050313',  // IBERIA: FIELD TEAM
    ];

    const allDeals = [];
    const properties = ['dealname', 'dealstage', 'pipeline', 'closedate', 'createdate', 'hs_deal_stage_probability', 'amount'];

    for (const pipelineId of pipelineIds) {
      try {
        let after = undefined;
        let page = 0;
        while (true && page < 50) {
          page++;
          const qs = `?limit=100&pipelineId=${pipelineId}${after ? '&after=' + after : ''}`;
          const url = `/crm/v3/objects/deals${qs}`;
          const params = new URLSearchParams();
          properties.forEach(p => params.append('properties', p));
          
          const data = await hubspotRequest(`/crm/v3/objects/deals?limit=100&pipelineId=${pipelineId}${after ? '&after=' + after : ''}${properties.length ? '&properties=' + properties.join('&properties=') : ''}`);
          
          if (data.results) {
            allDeals.push(...data.results);
          }
          
          if (!data.paging?.next?.after) break;
          after = data.paging.next.after;
        }
      } catch (e) {
        console.warn(`⚠️ Could not fetch HubSpot pipeline ${pipelineId}:`, e.message);
      }
    }

    res.json({
      success: true,
      summary: {
        totalDeals: allDeals.length,
        pipelines: pipelineIds.length,
        timestamp: new Date().toISOString()
      },
      deals: allDeals,
      _hint: 'Use this data for rendering HubSpot dashboards'
    });

  } catch (error) {
    console.error('❌ /api/hubspot error:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'Verify HUBSPOT_API_KEY is valid and HubSpot API is accessible'
    });
  }
});

// ═══════════════════════════════════════════════════════
// 📡 ENDPOINT: /pipedrive/*
// Proxy directo para llamadas Pipedrive (usado por dashboard JavaScript)
// ═══════════════════════════════════════════════════════
app.get('/pipedrive/*', async (req, res) => {
  try {
    if (!PIPEDRIVE_API_KEY) {
      return res.status(401).json({ error: 'PIPEDRIVE_API_KEY not configured' });
    }

    const path = req.params[0];
    const queryString = Object.keys(req.query).length > 0 ? '&' + new URLSearchParams(req.query).toString() : '';
    const url = `${PIPEDRIVE_BASE_URL}/${path}?api_token=${PIPEDRIVE_API_KEY}${queryString}`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    console.error('❌ /pipedrive proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// 📡 ENDPOINT: /hubspot/*
// Proxy directo para llamadas HubSpot (usado por dashboard JavaScript)
// ═══════════════════════════════════════════════════════
app.get('/hubspot/*', async (req, res) => {
  try {
    if (!HUBSPOT_API_KEY) {
      return res.status(401).json({ error: 'HUBSPOT_API_KEY not configured' });
    }

    const path = req.params[0];
    const queryString = Object.keys(req.query).length > 0 ? '?' + new URLSearchParams(req.query).toString() : '';
    const url = `${HUBSPOT_BASE_URL}/${path}${queryString}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('❌ /hubspot proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// ⚠️ 404 - Endpoint no encontrado
// ═══════════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    availableEndpoints: [
      'GET /api/health',
      'GET /api/pipedrive',
      'GET /api/hubspot',
      'GET /pipedrive/* (proxy)',
      'GET /hubspot/* (proxy)'
    ]
  });
});

// ═══════════════════════════════════════════════════════
// 🚀 INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  APM Pipedrive Proxy - Dashboard API Server                ║
╠════════════════════════════════════════════════════════════╣
║  🚀 Server running on: http://localhost:${PORT}
║  📡 Pipedrive: ${PIPEDRIVE_API_KEY ? '✅ Configured' : '❌ Missing API key'}
║  📊 HubSpot:   ${HUBSPOT_API_KEY ? '✅ Configured' : '❌ Missing API key'}
║                                                            ║
║  Available endpoints:                                      ║
║  • GET /api/health             (status check)             ║
║  • GET /api/pipedrive          (aggregated Pipedrive data)║
║  • GET /api/hubspot            (aggregated HubSpot data)  ║
║  • GET /pipedrive/*            (Pipedrive proxy)          ║
║  • GET /hubspot/*              (HubSpot proxy)            ║
╠════════════════════════════════════════════════════════════╣
║  Test: curl http://localhost:${PORT}/api/health
╚════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
