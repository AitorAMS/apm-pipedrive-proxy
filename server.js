'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// apm-pipedrive-proxy — server.js
// Añadido: Sync Agent + Cache + Endpoint /api/snapshot + Serve HTML estático
// ═══════════════════════════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Rutas de archivos ──────────────────────────────────────────────────────────
const CACHE_FILE = path.join(__dirname, 'data', 'snapshot.json');
const META_FILE  = path.join(__dirname, 'data', 'meta.json');
const HTML_FILE  = path.join(__dirname, 'public', 'dashboard.html');

// Crear carpetas si no existen
fs.mkdirSync(path.join(__dirname, 'data'),   { recursive: true });
fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });

// ── Config Pipedrive ───────────────────────────────────────────────────────────
const PD_TOKEN    = process.env.PIPEDRIVE_TOKEN || '';
const PD_BASE     = 'https://api.pipedrive.com/v1';
const APM_IDS     = [2, 3, 4, 9, 13, 17];
const LIVE_STAGE  = 104;

// Field hashes — Spain (Deployment.html)
const F = {
  svDone: '9b3b3995f1f726feaee7fdabbe6c7695ef7d7f09',
  svReq:  '67225c24d04109f7fa56373160b7efeb1ba7b857',
  svSch:  '5751376cbd3ce91828479ecd16f6ab3913b16f9e',
  svProv: '4eeb6232a77052b8f0ad39c199ecf8f2ad0eaa50',
  rdySv:  '7ac852e7f10486b93bbdf4a2a16dacc225eed886',
  egDone: '625c899d638cf47d9435ed048ab7383264b67771',
  egReq:  'ad7bee71b88f2813747efc61746be52aff2bac8b',
  egSch:  'f4b5f5248662fce649f697db0cd21dce984b93b4',
  egProv: '040eb4600ed2df829da452a308a2fdf27b76ddaa',
  inDep:  '8d746b4699d7c04a646436b0f1ae4d038b048ebd',
  inSch:  'aacf967fc363fbc73db37cc912b31a2fe343931a',
  inRmv:  'fa25efa2dd60a8f4abe4af567d9d3cf5fbf6b978',
  inProv: 'e6c9301c6c4c7751d212727024a1cfa507d13992',
  apPart: '5dad53f6ffced67539def909f4329c14f37783b1',
  indoor: 'b49c4d80d008ba209738f3bee0ed1fe548c5a4b4',
  exDone: '4a4e30eb9d47fc061dea264544ccd5b6b86c08dd',
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS — cache / meta
// ═══════════════════════════════════════════════════════════════════════════════
function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; }
}
function writeMeta(d) {
  fs.writeFileSync(META_FILE, JSON.stringify(d, null, 2));
}
function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}
function writeCache(d) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(d));
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS — semanas ISO 2026
// ═══════════════════════════════════════════════════════════════════════════════
function buildWeekRanges() {
  const map = {};
  const w1  = new Date('2025-12-29');
  const MON = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  for (let w = 1; w <= 53; w++) {
    const s = new Date(w1); s.setDate(w1.getDate() + (w - 1) * 7);
    const e = new Date(s);  e.setDate(s.getDate() + 6);
    map[`W${w}`] = {
      start: s.toISOString().slice(0, 10),
      end:   e.toISOString().slice(0, 10),
      label: `W${w} · ${s.getDate()} ${MON[s.getMonth()]}`,
    };
  }
  return map;
}
const WEEK_RANGES = buildWeekRanges();

function dateToWeek(dateStr) {
  if (!dateStr) return null;
  const d = String(dateStr).slice(0, 10);
  for (const [wk, r] of Object.entries(WEEK_RANGES)) {
    if (d >= r.start && d <= r.end) return wk;
  }
  return null;
}
function currentWeekNum() {
  const today = new Date().toISOString().slice(0, 10);
  for (const [wk, r] of Object.entries(WEEK_RANGES)) {
    if (today >= r.start && today <= r.end) return parseInt(wk.slice(1));
  }
  return 17; // fallback
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPEDRIVE — fetch con retry
// ═══════════════════════════════════════════════════════════════════════════════
async function pdGet(path, params = {}) {
  const url = new URL(`${PD_BASE}${path}`);
  url.searchParams.set('api_token', PD_TOKEN);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url.toString());
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('Retry-After') || '10') * 1000;
      console.log(`[pd] rate limit, esperando ${wait}ms`);
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    if (!r.ok) throw new Error(`Pipedrive HTTP ${r.status} en ${path}`);
    const j = await r.json();
    return j;
  }
  throw new Error(`Max retries en ${path}`);
}

// Paginar un endpoint de deals
async function pdPaginateDeals(basePath, extraParams = {}) {
  let all = [], start = 0, page = 0;
  while (true) {
    page++;
    const data = await pdGet(basePath, { ...extraParams, limit: 500, start });
    const items = data.data || [];
    all = all.concat(items);
    if (!data.additional_data?.pagination?.more_items_in_collection || !items.length) break;
    start += items.length;
    if (page > 60) break; // safety
  }
  return all;
}

// Fetch deals modificados desde `since` en todos los pipelines
async function fetchModifiedDeals(since) {
  console.log(`[pd] fetching deals modificados desde ${since}`);
  const sinceFormatted = since.replace('T', ' ').slice(0, 19);
  // Pipedrive acepta update_time como filtro en /deals
  const deals = await pdPaginateDeals('/deals', {
    filter_id: '',
    update_time: sinceFormatted,
    status: 'all_not_deleted',
  });
  // Filtrar solo los pipelines que nos interesan
  return deals.filter(d => APM_IDS.includes(d.pipeline_id));
}

// Fetch full de todos los pipelines (primera sync)
async function fetchAllDeals() {
  console.log('[pd] full load de todos los pipelines…');
  let all = [];
  for (const pid of APM_IDS) {
    const open = await pdPaginateDeals(`/pipelines/${pid}/deals`, { status: 'open' });
    const lost = await pdPaginateDeals(`/pipelines/${pid}/deals`, { status: 'lost' });
    all = all.concat(open, lost);
    console.log(`[pd] pipeline ${pid}: ${open.length} open + ${lost.length} lost`);
  }
  // Deduplicar
  const map = new Map(all.map(d => [d.id, d]));
  return [...map.values()];
}

// Field options (enum labels)
async function fetchFieldOptions() {
  const data = await pdGet('/dealFields', { limit: 500 });
  const opt = {};
  (data.data || []).forEach(f =>
    (f.options || []).forEach(o => { opt[o.id] = o.label; opt[String(o.id)] = o.label; })
  );
  return opt;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD SNAPSHOT — transforma deals crudos en el objeto que consume el HTML
// ═══════════════════════════════════════════════════════════════════════════════
function buildSnapshot(allDeals, OPT) {
  const re    = v => OPT[v] || OPT[String(v)] || String(v || '');
  const wkOf  = (d, f) => dateToWeek(d[f]);
  const incW  = (obj, wk, n = 1) => { if (wk) obj[wk] = (obj[wk] || 0) + n; };
  const CWN   = currentWeekNum();
  const today = new Date().toISOString().slice(0, 10);

  // Init weekly accumulators
  const W = {};
  const fields = [
    'svDone','apPart','egDone','inDep','rdySv',
    'svLost','egLost','inLost','inRmv','exDone',
  ];
  for (let i = 1; i <= 53; i++) {
    const wk = `W${i}`; W[wk] = {};
    fields.forEach(f => W[wk][f] = 0);
  }

  // Provider maps
  const provSurvey  = {}, provEg = {}, provInstall = {};
  // Pipeline stage counts (open deals)
  const pipeSurvey  = {}, pipeEg = {}, pipeInstall = {}, pipeLive = {};
  // Snapshot counters
  let liveCount = 0, pendingPartner = 0, survSched = 0, egSched = 0, instSched = 0, rfdBasket = 0;
  // Attention flags
  const att = {
    svNotScheduled: 0, svSchedOverdue: 0, posApprovalPending: 0,
    egNotRequested: 0, egReqNotSched: 0,  egSchedOverdue: 0,
    rfdNotSched: 0,    instSchedOverdue: 0,
  };
  // TTM days (survey → install)
  const ttmArr = [];

  for (const d of allDeals) {
    const pid  = d.pipeline_id;
    const sid  = d.stage_id;
    const open = d.status === 'open';
    const lost = d.status === 'lost';
    const sn   = d.stage_name || '';

    // ── Pipeline snapshots (open) ──────────────────────────────────────────
    if (open) {
      if (pid === 2) pipeSurvey[sn]  = (pipeSurvey[sn]  || 0) + 1;
      if (pid === 3) pipeEg[sn]      = (pipeEg[sn]      || 0) + 1;
      if (pid === 4) pipeInstall[sn] = (pipeInstall[sn] || 0) + 1;
      if (pid === 9) pipeLive[sn]    = (pipeLive[sn]    || 0) + 1;
    }

    // ── Live network count ─────────────────────────────────────────────────
    if (pid === 9 && open && sid === LIVE_STAGE) liveCount++;

    // ── Survey pipeline (pid 2) ────────────────────────────────────────────
    if (pid === 2) {
      if (d[F.svDone]) incW(W, wkOf(d, F.svDone), 'svDone');
      if (d[F.apPart]) incW(W, wkOf(d, F.apPart), 'apPart');
      if (lost && d[F.svDone]) incW(W, wkOf(d, F.svDone), 'svLost');

      // Provider by week
      if (d[F.svDone] && d[F.svProv]) {
        const wk = wkOf(d, F.svDone), pv = re(d[F.svProv]);
        if (wk) { provSurvey[wk] = provSurvey[wk] || {}; provSurvey[wk][pv] = (provSurvey[wk][pv] || 0) + 1; }
      }

      // Snapshot
      if (open && sn === 'Pending partner')  pendingPartner++;
      if (open && sn === 'Survey scheduled') survSched++;

      // Attention
      if (open && d[F.svReq] && !d[F.svSch]) {
        const age = (Date.now() - new Date(d[F.svReq])) / 86400000;
        if (age > 14) att.svNotScheduled++;
      }
      if (open && d[F.svSch] && !d[F.svDone] && String(d[F.svSch]).slice(0,10) < today) att.svSchedOverdue++;
      if (open && d[F.svDone] && !d[F.apPart]) {
        const age = (Date.now() - new Date(d[F.svDone])) / 86400000;
        if (age > 7) att.posApprovalPending++;
      }
    }

    // ── E&G pipeline (pid 3) ───────────────────────────────────────────────
    if (pid === 3) {
      if (d[F.egDone]) incW(W, wkOf(d, F.egDone), 'egDone');
      if (lost && d[F.egDone]) incW(W, wkOf(d, F.egDone), 'egLost');
      if (open && sn === 'E&G scheduled') egSched++;

      if (d[F.egDone] && d[F.egProv]) {
        const wk = wkOf(d, F.egDone), pv = re(d[F.egProv]);
        if (wk) { provEg[wk] = provEg[wk] || {}; provEg[wk][pv] = (provEg[wk][pv] || 0) + 1; }
      }

      if (open && d[F.egReq] && !d[F.egSch]) {
        const age = (Date.now() - new Date(d[F.egReq])) / 86400000;
        if (age > 7) att.egReqNotSched++;
      }
      if (open && d[F.egSch] && !d[F.egDone] && String(d[F.egSch]).slice(0,10) < today) att.egSchedOverdue++;
    }

    // ── Installation pipeline (pid 4) ──────────────────────────────────────
    if (pid === 4) {
      if (d[F.inDep])  incW(W, wkOf(d, F.inDep),  'inDep');
      if (d[F.inRmv])  incW(W, wkOf(d, F.inRmv),  'inRmv');
      if (lost && d[F.inDep]) incW(W, wkOf(d, F.inDep), 'inLost');

      if (d[F.inDep] && d[F.inProv]) {
        const wk = wkOf(d, F.inDep), pv = re(d[F.inProv]);
        if (wk) { provInstall[wk] = provInstall[wk] || {}; provInstall[wk][pv] = (provInstall[wk][pv] || 0) + 1; }
      }

      if (open && ['Ready for FAST','Ready for CONSOL'].includes(sn)) rfdBasket++;
      if (open && sn === 'Installation scheduled') instSched++;

      if (open && d[F.inSch] && !d[F.inDep] && String(d[F.inSch]).slice(0,10) < today) att.instSchedOverdue++;
    }

    // ── Extensions (pid 17) ───────────────────────────────────────────────
    if (pid === 17 && d[F.exDone]) incW(W, wkOf(d, F.exDone), 'exDone');

    // ── Ready for Survey (todos) ───────────────────────────────────────────
    if (d[F.rdySv]) incW(W, wkOf(d, F.rdySv), 'rdySv');

    // ── TTM ───────────────────────────────────────────────────────────────
    if (d[F.svDone] && d[F.inDep]) {
      const days = (new Date(d[F.inDep]) - new Date(d[F.svDone])) / 86400000;
      if (days >= 0 && days < 500) ttmArr.push(days);
    }
  }

  // ── YtD totals ─────────────────────────────────────────────────────────────
  const ytd = {};
  fields.forEach(f => {
    let s = 0;
    for (let i = 1; i <= CWN; i++) s += (W[`W${i}`] || {})[f] || 0;
    ytd[f] = s;
  });

  // ── Mediana TTM ────────────────────────────────────────────────────────────
  ttmArr.sort((a, b) => a - b);
  const ttmMed = ttmArr.length ? Math.round(ttmArr[Math.floor(ttmArr.length / 2)]) : null;

  // ── Construir objetos con los mismos nombres que usa el HTML ───────────────
  const weekly = {};
  for (let i = 1; i <= CWN; i++) {
    const wk = `W${i}`, r = WEEK_RANGES[wk], wr = W[wk] || {};
    weekly[wk] = {
      from:               r ? r.start.slice(5).replace('-','/') : '',
      to:                 r ? r.end.slice(5).replace('-','/')   : '',
      new_rfs:            wr.rdySv   || 0,
      survey_completed:   wr.svDone  || 0,
      position_approved:  wr.apPart  || 0,
      eg_completed_rfd:   wr.egDone  || 0,
      deployment:         wr.inDep   || 0,
      extensions:         wr.exDone  || 0,
      removed:            wr.inRmv   || 0,
      survey_lost:        wr.svLost  || 0,
      eg_lost:            wr.egLost  || 0,
      install_lost:       wr.inLost  || 0,
    };
    if (i === CWN) weekly[wk].partial = true;
  }

  return {
    // El HTML espera estos campos en el mismo nivel
    ALL_COUNT:      allDeals.length,
    CURRENT_WK:     CWN,
    weekly,           // sustituye DATA.weekly
    weeklyProv: { survey: provSurvey, eg: provEg, install: provInstall },
    pipeline: {
      survey:  pipeSurvey,
      eg:      pipeEg,
      install: pipeInstall,
      live:    pipeLive,
    },
    snapshot: {
      pendingPartner,
      surveyScheduledOpen: survSched,
      egScheduledOpen:     egSched,
      installScheduledOpen: instSched,
      rfdBasket,
      liveTotal:           liveCount,
    },
    ytd,
    attention: att,
    ttm: { med: ttmMed, n: ttmArr.length },
    // Metadatos
    sync_at:  new Date().toISOString(),
    version:  readMeta().version || 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC AGENT — corre en servidor, actualiza cache cada hora
// ═══════════════════════════════════════════════════════════════════════════════
let syncRunning = false;

async function runSync(mode = 'incremental') {
  if (syncRunning) { console.log('[sync] ya en curso, skip'); return; }
  syncRunning = true;
  const t0 = Date.now();

  try {
    console.log(`[sync] iniciando (modo: ${mode})…`);
    const meta = readMeta();

    let allDeals;
    if (mode === 'full' || !meta.last_sync || !fs.existsSync(CACHE_FILE)) {
      // Primera vez o full refresh: cargar todo
      allDeals = await fetchAllDeals();
    } else {
      // Incremental: solo deals modificados desde la última sync
      const updated = await fetchModifiedDeals(meta.last_sync);
      console.log(`[sync] ${updated.length} deals modificados`);

      // Merge sobre el cache existente
      const existing = readCache();
      const dealMap  = new Map((existing?.rawDeals || []).map(d => [d.id, d]));
      updated.forEach(d => dealMap.set(d.id, d));
      allDeals = [...dealMap.values()];
    }

    // Field options (solo si no existen)
    const existingCache = readCache();
    const OPT = (existingCache?.OPT && Object.keys(existingCache.OPT).length > 0)
      ? existingCache.OPT
      : await fetchFieldOptions();

    // Construir snapshot
    const snapshot = buildSnapshot(allDeals, OPT);

    // Escribir cache
    const newMeta = {
      last_sync:   new Date().toISOString(),
      version:     (meta.version || 0) + 1,
      total_deals: allDeals.length,
      duration_ms: Date.now() - t0,
      last_error:  null,
    };
    writeCache({ ...snapshot, OPT, rawDeals: allDeals });
    writeMeta(newMeta);

    console.log(`[sync] ✓ completado en ${newMeta.duration_ms}ms · ${allDeals.length} deals · v${newMeta.version}`);
  } catch (e) {
    console.error(`[sync] ERROR: ${e.message}`);
    const meta = readMeta();
    writeMeta({ ...meta, last_error: e.message });
  } finally {
    syncRunning = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Servir el dashboard HTML ─────────────────────────────────────────────────
// El HTML se sirve desde /public/dashboard.html
// Si no existe, muestra placeholder
app.get('/', (req, res) => {
  if (fs.existsSync(HTML_FILE)) {
    res.sendFile(HTML_FILE);
  } else {
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#1D1D1D;color:#FFCC05">
        <h2>InPost Spain · KPI Dashboard</h2>
        <p style="color:#888">Coloca tu Deployment.html en <code>public/dashboard.html</code></p>
        <p style="color:#888">Cache: <a href="/api/snapshot" style="color:#FFCC05">/api/snapshot</a></p>
      </body></html>
    `);
  }
});

// Servir archivos estáticos de /public
app.use(express.static(path.join(__dirname, 'public')));

// ── /api/snapshot — el HTML carga los datos desde aquí ───────────────────────
app.get('/api/snapshot', (req, res) => {
  const cache = readCache();
  if (!cache) {
    return res.status(503).json({
      ok: false,
      error: 'Cache no disponible — primera sync en curso',
      retry_after: 30,
    });
  }
  // Devolver todo excepto rawDeals (demasiado grande para el front)
  const { rawDeals, OPT: _opt, ...data } = cache;
  res.json({ ok: true, ...data, OPT: _opt });
});

// ── /api/sync — trigger manual (GitHub Actions lo llama cada hora) ────────────
app.post('/api/sync', async (req, res) => {
  const secret = req.headers['x-sync-secret'];
  if (process.env.SYNC_SECRET && secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const mode = req.body?.mode || 'incremental';
  res.json({ ok: true, message: `Sync ${mode} iniciado`, running: syncRunning });
  if (!syncRunning) runSync(mode); // no await — responde inmediatamente
});

// ── /api/status — health check y métricas ────────────────────────────────────
app.get('/api/status', (req, res) => {
  const meta  = readMeta();
  const cache = readCache();
  const minAgo = meta.last_sync
    ? Math.round((Date.now() - new Date(meta.last_sync)) / 60000)
    : null;

  res.json({
    ok:          !!cache,
    sync_at:     meta.last_sync || null,
    min_ago:     minAgo,
    version:     meta.version   || 0,
    total_deals: meta.total_deals || 0,
    duration_ms: meta.duration_ms || 0,
    last_error:  meta.last_error  || null,
    sync_running: syncRunning,
    cache_ready: !!cache,
  });
});

// ── Ruta legacy del proxy (mantener compatibilidad con el HTML antiguo) ────────
app.get('/pipedrive/*', async (req, res) => {
  if (!PD_TOKEN) return res.status(401).json({ error: 'No token configurado' });
  try {
    const pdPath = req.path.replace('/pipedrive', '');
    const params = new URLSearchParams(req.query);
    params.set('api_token', PD_TOKEN);
    const r = await fetch(`${PD_BASE}${pdPath}?${params}`);
    const j = await r.json();
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARRANQUE
// ═══════════════════════════════════════════════════════════════════════════════
const SYNC_INTERVAL = 60 * 60 * 1000; // 60 minutos

app.listen(PORT, async () => {
  console.log(`[server] escuchando en puerto ${PORT}`);

  if (!PD_TOKEN) {
    console.warn('[server] ⚠ PIPEDRIVE_TOKEN no definido — el sync no funcionará');
    return;
  }

  // Sync inicial si el cache tiene más de 1h o no existe
  const meta    = readMeta();
  const cacheOk = fs.existsSync(CACHE_FILE);
  const age     = meta.last_sync
    ? Date.now() - new Date(meta.last_sync).getTime()
    : Infinity;

  if (!cacheOk || age > SYNC_INTERVAL) {
    console.log('[server] cache ausente o viejo — arrancando full sync…');
    await runSync('full');
  } else {
    console.log(`[server] cache OK (v${meta.version}, hace ${Math.round(age/60000)} min)`);
  }

  // Cron cada 60 minutos
  setInterval(() => runSync('incremental'), SYNC_INTERVAL);
  console.log('[server] cron activo · sync cada 60 min');
});
