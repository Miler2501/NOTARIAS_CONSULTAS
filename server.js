const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

// Opciones de ejecución y reintentos
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || '1500', 10);
const BACKOFF_MULT = parseFloat(process.env.BACKOFF_MULT || '1.8');

// Concurrency (1 = secuencial, >1 = paralelos limitados)
const PARALLEL_CONCURRENCY = Math.max(1, parseInt(process.env.PARALLEL_CONCURRENCY || '1', 10));

// Plugin opcional para recaptcha
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
const USE_RECAPTCHA_PLUGIN = (process.env.USE_RECAPTCHA_PLUGIN || 'false').toLowerCase() === 'true';
if (USE_RECAPTCHA_PLUGIN && HAS_ANTI_CAPTCHA_KEY) {
  puppeteer.use(RecaptchaPlugin({ provider: { id: 'anticaptcha', token: process.env.ANTI_CAPTCHA_KEY }, visualFeedback: true }));
}

// Comportamiento de la app respecto a la anti-captcha key
// Si ANTI_CAPTCHA_REQUIRED (true|false) es true (por defecto), la app fallará al arrancar
// cuando no exista ANTI_CAPTCHA_KEY. Si ANTI_CAPTCHA_REQUIRED=false, la app seguirá
// funcionando pero no intentará resolver captchas automáticamente.
const ANTI_CAPTCHA_REQUIRED = (process.env.ANTI_CAPTCHA_REQUIRED || 'true').toLowerCase() !== 'false';
const HAS_ANTI_CAPTCHA_KEY = !!process.env.ANTI_CAPTCHA_KEY;

if (ANTI_CAPTCHA_REQUIRED && !HAS_ANTI_CAPTCHA_KEY) {
  console.error('❌ ERROR: La variable de entorno ANTI_CAPTCHA_KEY no está definida y ANTI_CAPTCHA_REQUIRED está activado. Define ANTI_CAPTCHA_KEY o setea ANTI_CAPTCHA_REQUIRED=false para desarrollo.');
  process.exit(1);
}

if (!HAS_ANTI_CAPTCHA_KEY) {
  console.warn('⚠️ ANTI_CAPTCHA_KEY no encontrada. La app continuará pero no resolverá captchas automáticamente. Para producción habilita ANTI_CAPTCHA_KEY o activa ANTI_CAPTCHA_REQUIRED.');
}

const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname), { index: false }));

// rate limiting configurable
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '6', 10);
const pdfLimiter = rateLimit({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false });

// Telemetría (simple): en memoria + archivo
const telemetryStore = { attempts: [], stats: { total: 0, successes: 0, failures: 0 } };
const LOGS_DIR = path.join(__dirname, 'logs');
try { if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR); } catch(e) {}
function telemetryAppend(obj) {
  telemetryStore.attempts.unshift(obj);
  if (telemetryStore.attempts.length > 200) telemetryStore.attempts.pop();
  telemetryStore.stats.total += 1;
  if (obj.success) telemetryStore.stats.successes += 1; else telemetryStore.stats.failures += 1;
  try { fs.appendFileSync(path.join(LOGS_DIR, 'telemetry.log'), JSON.stringify(obj) + '\n'); } catch (e) { console.warn('No se pudo persistir telemetry.log:', e.message); }
}

// Proxy health / pool
let proxyPool = [];
let deadProxies = new Set();
const PROXY_HEALTH_INTERVAL_MS = parseInt(process.env.PROXY_HEALTH_INTERVAL_MS || String(1000 * 60 * 10), 10);
const PROXY_HEALTH_TIMEOUT_MS = parseInt(process.env.PROXY_HEALTH_TIMEOUT_MS || String(8000), 10);

function parseProxyUrl(u) {
  if (!u) return null;
  let raw = u.trim(); if (!raw) return null;
  try { if (!raw.includes('://')) raw = 'http://' + raw; const url = new URL(raw); return { original: u, protocol: url.protocol.replace(':',''), host: url.hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80'), username: url.username || null, password: url.password || null }; } catch (e) { return { original: u, invalid: true }; }
}

async function checkProxyHealth(proxyString) {
  const parsed = parseProxyUrl(proxyString);
  if (!parsed || parsed.invalid) return { ok: false, error: 'invalid_proxy_format' };
  try {
    const [host, port] = [parsed.host, parseInt(parsed.port, 10)];
    const auth = parsed.username && parsed.password ? { username: parsed.username, password: parsed.password } : undefined;
    const axiosOpts = { url: 'https://www.google.com/search?q=robots', method: 'GET', timeout: PROXY_HEALTH_TIMEOUT_MS, proxy: { host, port } };
    if (auth) axiosOpts.proxy.auth = auth;
    await axios(axiosOpts);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function initProxyPoolFromEnv() {
  const raw = process.env.PROXY_LIST || '';
  proxyPool = raw.split(',').map(s => s.trim()).filter(Boolean).map(parseProxyUrl).filter(Boolean).map(p => p.original);
  deadProxies = new Set();
}

async function updateProxyHealthAll() {
  if (!proxyPool || proxyPool.length === 0) return { checked: 0 };
  const results = [];
  for (const p of proxyPool) {
    try {
      const ok = await checkProxyHealth(p);
      results.push({ proxy: p, ok: ok.ok, error: ok.error || null });
      if (!ok.ok) deadProxies.add(p); else deadProxies.delete(p);
    } catch (e) { results.push({ proxy: p, ok: false, error: e.message }); deadProxies.add(p); }
  }
  return { checked: results.length, results };
}

initProxyPoolFromEnv();
if (proxyPool.length > 0) setImmediate(() => updateProxyHealthAll().catch(() => {}));
if (proxyPool.length > 0 && PROXY_HEALTH_INTERVAL_MS > 0) setInterval(() => updateProxyHealthAll().catch(e => console.warn('proxy health check failed', e.message)), PROXY_HEALTH_INTERVAL_MS);

// Helper: realizar un solo intento de generación con un proxy específico (o null)
async function attemptGeneratePdf(query, chosenProxy) {
  let browser = null;
  try {
    const launchArgs = ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'];
    if (chosenProxy) launchArgs.push(`--proxy-server=${chosenProxy}`);

    browser = await puppeteer.launch({ headless: 'new', args: launchArgs });
    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'Connection': 'keep-alive', 'Upgrade-Insecure-Requests': '1' });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    // proxy auth
    if (chosenProxy && (chosenProxy.includes('@') || chosenProxy.includes('://'))) {
      try { let p = chosenProxy; if (!p.includes('://')) p = 'http://' + p; const url = new URL(p); if (url.username || url.password) await page.authenticate({ username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }); } catch (e) { console.warn('⚠️ Proxy auth parse failed', e.message); }
    }

    await page.setViewport({ width: 1366, height: 768 });
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14&hl=es&gl=pe`;

    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const hasCaptcha = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('no soy un robot') || text.includes("i'm not a robot") || text.includes('unusual traffic') || text.includes('tráfico inusual') || document.querySelector('iframe[src*="recaptcha"]') !== null;
    });

    if (hasCaptcha) {
      if (!HAS_ANTI_CAPTCHA_KEY) throw new Error('captcha_detected_no_key');
      if (USE_RECAPTCHA_PLUGIN) {
        // plugin will auto-solve if configured earlier
        try { await page.solveRecaptchas(); } catch (e) { throw new Error('plugin_recaptcha_error:' + e.message); }
      } else {
        // manual anti-captcha flow
        let siteKey = await page.evaluate(() => { const el = document.querySelector('[data-sitekey]'); if (el) return el.getAttribute('data-sitekey'); const g = document.querySelector('.g-recaptcha'); if (g) return g.getAttribute('data-sitekey'); return null; });
        if (!siteKey) { for (const frame of page.frames()) { const u = frame.url(); if (u.includes('recaptcha') && u.includes('k=')) { const m = u.match(/k=([^&]+)/); if (m) { siteKey = m[1]; break; } } }}
        if (!siteKey) throw new Error('no_sitekey');
        const create = await axios.post('https://api.anti-captcha.com/createTask', { clientKey: process.env.ANTI_CAPTCHA_KEY, task: { type: 'RecaptchaV2TaskProxyless', websiteURL: searchUrl, websiteKey: siteKey } });
        if (create.data.errorId !== 0) throw new Error('anticaptcha_create_error');
        const taskId = create.data.taskId; let gResponse = null; for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 2000)); const result = await axios.post('https://api.anti-captcha.com/getTaskResult', { clientKey: process.env.ANTI_CAPTCHA_KEY, taskId }); if (result.data.errorId !== 0) throw new Error('anticaptcha_result_err'); if (result.data.status === 'ready') { gResponse = result.data.solution.gRecaptchaResponse; break; } }
        if (!gResponse) throw new Error('anticaptcha_timeout');
        await page.evaluate((token) => { let t = document.getElementById('g-recaptcha-response'); if (!t) { t = document.createElement('textarea'); t.id='g-recaptcha-response'; t.name='g-recaptcha-response'; t.style.display='none'; document.body.appendChild(t); } t.value = token; t.innerHTML = token; }, gResponse);
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // cleanup overlays
    await page.evaluate(() => { const recaptchaSelectors = ['iframe[src*="recaptcha"]', '.g-recaptcha', '.grecaptcha-badge', 'div[id^="rc-"]', '.rc-imageselect', '#recaptcha']; recaptchaSelectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove())); Array.from(document.querySelectorAll('*')).forEach(el=>{ try{ const style = getComputedStyle(el); if (style && style.zIndex && parseInt(style.zIndex) > 1000) el.style.display='none'; }catch(e){}}); document.querySelectorAll('.rc-imageselect, .g-recaptcha').forEach(el => { if (el) { const placeholder = document.createElement('div'); placeholder.style = 'padding:12px;border:2px dashed #c00;color:#c00;background:#fff9f9;margin:8px 0;'; placeholder.innerText = 'Imagen no disponible: captcha detectado o bloqueado.'; el.replaceWith(placeholder); } }); });

    try {
      await page.waitForFunction(() => { 
        const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.offsetParent !== null); 
        if (imgs.length === 0) return true; 
        return imgs.every(img => img.complete && img.naturalWidth > 0); 
      }, { timeout: 8000 });
    } catch (e) {
      // Ignorar errores de espera de imágenes
    }

    const stillBlocked = await page.evaluate(() => { const text = document.body.innerText.toLowerCase(); return text.includes('no soy un robot') || text.includes("i'm not a robot") || text.includes('unusual traffic') || text.includes('tráfico inusual'); });
    if (stillBlocked) throw new Error('blocked_after_all');

    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' } });
    return { pdfBuffer };
  } catch (err) {
    // Propagar el error para que el caller pueda manejarlo
    throw err;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore close errors */ }
    }
  }
}


app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'buscador.html');
  fs.readFile(htmlPath, 'utf8', (err, data) => {
    if (err) {
      res.status(500).send('Error al cargar la página');
      return;
    }
    res.type('html').send(data);
  });
});

app.post('/generar-pdf', pdfLimiter, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).send('Falta el query');

  const availableProxies = (proxyPool && proxyPool.length > 0) ? proxyPool.filter(p => !deadProxies.has(p)) : [];
  const proxyCandidates = availableProxies.length > 0 ? availableProxies : ((process.env.PROXY_LIST || '').split(',').map(s => s.trim()).filter(Boolean));

  let attemptsUsed = 0;
  let lastError = null;

  while (attemptsUsed < MAX_RETRIES) {
    const remaining = MAX_RETRIES - attemptsUsed;
    const batchSize = Math.min(PARALLEL_CONCURRENCY, remaining);

    const batch = Array.from({ length: batchSize }).map(async () => {
      const pick = proxyCandidates.length > 0 ? proxyCandidates[Math.floor(Math.random() * proxyCandidates.length)] : null;
      try {
        const start = Date.now();
        const r = await attemptGeneratePdf(query, pick);
        return { ok: true, buffer: r.pdfBuffer, proxy: pick, duration: Date.now() - start };
      } catch (e) {
        return { ok: false, error: e.message || String(e), proxy: pick };
      }
    });

    const results = await Promise.all(batch);
    attemptsUsed += batchSize;

    const success = results.find(x => x.ok);
    if (success) {
      await telemetryAppend({ timestamp: new Date().toISOString(), query, attempt: attemptsUsed, proxy: success.proxy, success: true, duration: success.duration });
      res.set({ 'Content-Type': 'application/pdf', 'Content-Length': success.buffer.length, 'Content-Disposition': 'attachment; filename="reporte_ia.pdf"' });
      return res.send(success.buffer);
    }

    // store failures and mark proxies dead
    for (const r of results) {
      await telemetryAppend({ timestamp: new Date().toISOString(), query, attempt: attemptsUsed, proxy: r.proxy, success: false, error: r.error });
      if (r.proxy) deadProxies.add(r.proxy);
      lastError = r.error || lastError;
    }

    // backoff before next batch of attempts
    const backoff = Math.floor(RETRY_DELAY_MS * Math.pow(BACKOFF_MULT, attemptsUsed));
    await new Promise(r => setTimeout(r, backoff));
  }

  // All attempts exhausted — record telemetry and return a friendly fallback PDF
  await telemetryAppend({ timestamp: new Date().toISOString(), query, attempt: attemptsUsed, success: false, error: lastError || 'unknown' });

  try {
    const browser2 = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page2 = await browser2.newPage();
    const messageHtml = `<html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#222} h1{color:#c33}</style></head><body><h1>No fue posible generar el PDF</h1><p>No pudimos generar el PDF tras ${attemptsUsed} intentos.</p><p>Último error: ${String(lastError)}</p><p>Verifique la conexión, proxy o la configuración de Anti-Captcha.</p></body></html>`;
    await page2.setContent(messageHtml, { waitUntil: 'networkidle0' });
    const pdfFallback = await page2.pdf({ format: 'A4', printBackground: true });
    await browser2.close();
    res.set({ 'Content-Type': 'application/pdf', 'Content-Length': pdfFallback.length, 'Content-Disposition': 'attachment; filename="reporte_ia_fallback.pdf"' });
    return res.send(pdfFallback);
  } catch (e) {
    console.error('❌ Error generando PDF final de fallback:', e.message);
    if (!res.headersSent) return res.status(500).json({ error: 'No fue posible generar el PDF', details: e.message });
  }
});

// Endpoint de diagnóstico para comprobar si una búsqueda provoca captcha y obtener info útil
app.get('/debug-captcha', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Falta el parámetro query. Ej: /debug-captcha?query=tu+busqueda' });

  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14&hl=es&gl=pe`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    const hasCaptcha = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('no soy un robot') || text.includes("i'm not a robot") ||
        text.includes('unusual traffic') || text.includes('tráfico inusual') ||
        document.querySelector('iframe[src*="recaptcha"]') !== null;
    });

    let siteKey = null;
    if (hasCaptcha) {
      siteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        if (el) return el.getAttribute('data-sitekey');
        const g = document.querySelector('.g-recaptcha');
        if (g) return g.getAttribute('data-sitekey');
        return null;
      });
    }

    // envia un resumen simple
    res.json({ ok: true, query, url: searchUrl, hasCaptcha, siteKey });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// Estado / health checks
app.get('/status', (req, res) => {
  try {
    return res.json({ ok: true, stats: telemetryStore.stats, recentAttempts: telemetryStore.attempts.slice(0, 10), proxyPoolSize: proxyPool.length, deadProxies: Array.from(deadProxies), hasAntiCaptchaKey: HAS_ANTI_CAPTCHA_KEY, antiCaptchaRequired: ANTI_CAPTCHA_REQUIRED });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/proxy-health', async (req, res) => {
  try {
    const r = await updateProxyHealthAll();
    return res.json({ ok: true, results: r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// API: consultar datos por DNI (mock local o proxy a servicio externo si está configurado)
app.get('/api/dni/:dni', async (req, res) => {
  const { dni } = req.params;
  if (!/^[0-9]{8}$/.test(dni)) return res.status(400).json({ ok: false, error: 'dni_invalid', message: 'El DNI debe tener 8 dígitos numéricos' });

  // Si existe una URL externa, reenvía la petición
  const upstream = process.env.DNI_API_URL;
  if (upstream) {
    try {
      const base = upstream.replace(/\/$/, '');
      const r = await axios.get(`${base}/api/dni/${dni}`, { timeout: 10000 });
      return res.status(r.status).json(r.data);
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'upstream_error', details: e.message });
    }
  }

  // Respuesta mock para pruebas locales / despliegue rápido
  const mock = {
    dni,
    nombres: 'JUAN CARLOS',
    apellido_paterno: 'PEREZ',
    apellido_materno: 'GOMEZ',
    fecha_nacimiento: '1987-06-15',
    distrito: 'LIMA',
    departamento: 'LIMA',
    estado: 'ACTIVO'
  };
  return res.json({ ok: true, source: 'mock', data: mock });
});

// Endpoint de versión/diagnóstico para confirmar el despliegue
app.get('/version', (req, res) => {
  try {
    const pkg = require('./package.json');
    let commit = process.env.DEPLOY_COMMIT || null;
    if (!commit) {
      try {
        const p = require('path');
        const fp = p.join(__dirname, 'deploy.sha');
        if (require('fs').existsSync(fp)) commit = require('fs').readFileSync(fp, 'utf8').trim();
      } catch (e) { }
    }
    return res.json({ ok: true, commit: commit, version: pkg.version || null, ts: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const server = app.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ Puerto ${PORT} en uso.`);
    process.exit(1);
  }
});
