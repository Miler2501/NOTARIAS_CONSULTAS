const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

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

app.get('/api/dni/:numero', async (req, res) => {
  try {
    const { numero } = req.params;
    const url = `https://hostingviper.com/consultas/public/buscar?semilla=S0p0rt32025@*&dni=${numero}`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (error) {
    console.error('Error al consultar DNI:', error.message);
    res.status(500).json({ error: 'Error al consultar DNI' });
  }
});

app.get('/api/ruc/:numero', async (req, res) => {
  try {
    const { numero } = req.params;
    const url = `https://api.apis.net.pe/v1/ruc?numero=${numero}`;
    const response = await axios.get(url);
    res.json({ data: { nombre_o_razon_social: response.data.nombre } });
  } catch (error) {
    console.error('Error al consultar RUC:', error.message);
    res.status(500).json({ error: 'Error al consultar RUC' });
  }
});

app.post('/generar-pdf', pdfLimiter, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).send('Falta el query');

  let browser = null;

  try {
    console.log(`📄 Iniciando generación de PDF para: ${query}`);

      // construye opciones de lanzamiento para puppeteer, opcionalmente usando proxies
      const launchArgs = ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'];

      // soporte básico para rotación de proxies (lista separada por comas en PROXY_LIST)
      let chosenProxy = null;
      if (process.env.PROXY_LIST) {
        const proxies = process.env.PROXY_LIST.split(',').map(s => s.trim()).filter(Boolean);
        if (proxies.length > 0) {
          const idx = Math.floor(Math.random() * proxies.length);
          chosenProxy = proxies[idx];
          launchArgs.push(`--proxy-server=${chosenProxy}`);
          console.log('🌐 Usando proxy:', chosenProxy);
        }
      }

      browser = await puppeteer.launch({ headless: 'new', args: launchArgs });

    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    // Si el proxy requiere autenticación, inyecta credenciales en la página
    if (chosenProxy && (chosenProxy.includes('@') || chosenProxy.includes('://'))) {
      try {
        // parse proxy (soporta formatos: user:pass@host:port o protocol://user:pass@host:port)
        let p = chosenProxy;
        if (!p.includes('://')) p = 'http://' + p;
        const url = new URL(p);
        if (url.username || url.password) {
          await page.authenticate({ username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
        }
      } catch (e) {
        console.warn('⚠️ No se pudo parsear proxy para autenticación:', e.message);
      }
    }
    await page.setViewport({ width: 1366, height: 768 });

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14&hl=es&gl=pe`;

    console.log(`🌐 Navegando a Google IA: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const hasCaptcha = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('no soy un robot') || text.includes("i'm not a robot") ||
        text.includes('unusual traffic') || text.includes('tráfico inusual') ||
        document.querySelector('iframe[src*="recaptcha"]') !== null;
    });

    if (hasCaptcha) {
      console.log('⚠️ Captcha detectado.');

      if (!HAS_ANTI_CAPTCHA_KEY) {
        console.warn('⚠️ Captcha detectado pero ANTI_CAPTCHA_KEY no está disponible — no intentaré resolverlo (modo sin key).');
      } else {
        console.log('Resolviendo con Anti-Captcha API REST...');

        try {
        let siteKey = await page.evaluate(() => {
          const el = document.querySelector('[data-sitekey]');
          if (el) return el.getAttribute('data-sitekey');
          const g = document.querySelector('.g-recaptcha');
          if (g) return g.getAttribute('data-sitekey');
          return null;
        });

        if (!siteKey) {
          const frames = page.frames();
          for (const frame of frames) {
            const url = frame.url();
            if (url.includes('recaptcha') && url.includes('k=')) {
              const match = url.match(/k=([^&]+)/);
              if (match) {
                siteKey = match[1];
                break;
              }
            }
          }
        }

        if (!siteKey) throw new Error('No se encontró el sitekey');

        console.log(`🔑 SiteKey: ${siteKey}`);
        console.log('📤 Enviando a Anti-Captcha...');

        const ANTI_CAPTCHA_KEY = process.env.ANTI_CAPTCHA_KEY; // debe estar definida, se valida al inicio del proceso

        const createTaskResponse = await axios.post('https://api.anti-captcha.com/createTask', {
          clientKey: ANTI_CAPTCHA_KEY,
          task: { type: 'RecaptchaV2TaskProxyless', websiteURL: searchUrl, websiteKey: siteKey }
        });

        if (createTaskResponse.data.errorId !== 0) {
          throw new Error(createTaskResponse.data.errorDescription || 'Error desconocido');
        }

        const taskId = createTaskResponse.data.taskId;
        console.log(`📋 Tarea ${taskId} creada. Esperando...`);

        let gResponse = null;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 2000));

          const result = await axios.post('https://api.anti-captcha.com/getTaskResult', {
            clientKey: ANTI_CAPTCHA_KEY,
            taskId: taskId
          });

          if (result.data.errorId !== 0) throw new Error(result.data.errorDescription);

          if (result.data.status === 'ready') {
            gResponse = result.data.solution.gRecaptchaResponse;
            console.log('✅ Captcha resuelto!');
            break;
          }

          if (i % 5 === 0) console.log(`⏳ Esperando... (${i * 2}s)`);
        }

        if (!gResponse) throw new Error('Timeout esperando resolución');

        console.log('✅ Captcha resuelto!');
        console.log('💉 Inyectando token y probando desbloqueo...');

        await page.evaluate((token) => {
          let textarea = document.getElementById('g-recaptcha-response');
          if (!textarea) {
            textarea = document.createElement('textarea');
            textarea.id = 'g-recaptcha-response';
            textarea.name = 'g-recaptcha-response';
            textarea.className = 'g-recaptcha-response';
            textarea.style.display = 'none';
            document.body.appendChild(textarea);
          }
          textarea.value = token;
          textarea.innerHTML = token;
        }, gResponse);

        console.log('🖱️ Simulando comportamiento humano...');

        await page.mouse.move(100, 100);
        await new Promise(r => setTimeout(r, 500));
        await page.mouse.move(300, 400);
        await new Promise(r => setTimeout(r, 500));

        await page.evaluate(() => {
          window.scrollBy(0, 100);
        });
        await new Promise(r => setTimeout(r, 1000));

        await new Promise(r => setTimeout(r, 3000));

        console.log('🖱️ Intentando hacer click en elementos del captcha...');
        try {
          const recaptchaFrame = page.frames().find(frame => frame.url().includes('recaptcha/api2/anchor'));
          if (recaptchaFrame) {
            await recaptchaFrame.click('.recaptcha-checkbox-border');
            console.log('✓ Click en checkbox del reCAPTCHA');
            await new Promise(r => setTimeout(r, 2000));
          }

          const submitButton = await page.$('button[type="submit"]');
          if (submitButton) {
            await submitButton.click();
            console.log('✓ Click en botón de submit');
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch (e) {
          console.log('ℹ️  No se encontraron elementos clicables del captcha');
        }

        console.log('🔄 Navegando de nuevo a la URL con la cookie del captcha...');
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));

        const stillBlocked = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('no soy un robot') || text.includes("i'm not a robot") ||
            text.includes('unusual traffic') || text.includes('tráfico inusual');
        });

        if (stillBlocked) {
          console.warn('⚠️ Advertencia: La página aún muestra bloqueo después de resolver el captcha. Intentaré limpiar overlays y ocultar elementos de captcha antes de capturar.');

          // intenta eliminar o ocultar elementos visuales de captcha que cubren la página
          try {
            await page.evaluate(() => {
              const recaptchaSelectors = [
                'iframe[src*="recaptcha"]', '.g-recaptcha', '.grecaptcha-badge', 'div[id^="rc-"]', '.rc-imageselect', '#recaptcha'
              ];
              recaptchaSelectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()));

              // Oculta elementos con z-index muy alto que probablemente bloquean la UI
              Array.from(document.querySelectorAll('*')).forEach(el => {
                try {
                  const style = getComputedStyle(el);
                  if (style && style.zIndex && parseInt(style.zIndex) > 1000) {
                    el.style.display = 'none';
                  }
                } catch (e) { /* ignore cross-origin or computed style errors */ }
              });

              // Asegura que cuerpo sea scrollable y visible
              document.documentElement.style.overflow = 'visible';
              document.body.style.overflow = 'visible';
            });

            // small wait to let layout settle after removals
            await new Promise(r => setTimeout(r, 1200));

          } catch (cleanupErr) {
            console.warn('❌ Falló limpieza de overlays:', cleanupErr.message);
          }

        } else {
          console.log('🎉 Desbloqueo exitoso! Página accesible.');
        }

      } catch (captchaError) {
        console.error('❌ Error resolviendo captcha:', captchaError.message);
      }
      }
    } else {
      console.log('✅ No hay captcha. Continuando...');
    }

    await new Promise(r => setTimeout(r, 2000));

    // Antes de generar el PDF: limpiar overlays y elementos de captcha para evitar que aparezcan en la captura
    try {
      await page.evaluate(() => {
        const recaptchaSelectors = [
          'iframe[src*="recaptcha"]', '.g-recaptcha', '.grecaptcha-badge', 'div[id^="rc-"]', '.rc-imageselect', '#recaptcha'
        ];
        recaptchaSelectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()));

        // oculta elementos con z-index muy alto
        Array.from(document.querySelectorAll('*')).forEach(el => {
          try {
            const style = getComputedStyle(el);
            if (style && style.zIndex && parseInt(style.zIndex) > 1000) {
              el.style.display = 'none';
            }
          } catch (e) {}
        });

        // Si hay contenedores de imágenes bloqueadas, reemplazar por mensaje visible
        document.querySelectorAll('.rc-imageselect, .g-recaptcha').forEach(el => {
          if (el) {
            const placeholder = document.createElement('div');
            placeholder.style = 'padding:12px;border:2px dashed #c00;color:#c00;background:#fff9f9;margin:8px 0;';
            placeholder.innerText = 'Imagen no disponible: captcha detectado o bloqueado.';
            el.replaceWith(placeholder);
          }
        });
      });

      // Espera a que imágenes visibles se carguen (si hay) para evitar capturar placeholders vacíos
      try {
        await page.waitForFunction(() => {
          const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.offsetParent !== null);
          if (imgs.length === 0) return true; // nothing to wait for
          return imgs.every(img => img.complete && img.naturalWidth > 0);
        }, { timeout: 8000 });
      } catch (waitErr) {
        console.warn('⏳ No todas las imágenes cargaron a tiempo, continuando con la generación del PDF.');
      }

    } catch (cleanupErr) {
      console.warn('❌ Error durante limpieza previa a PDF:', cleanupErr.message);
    }

    // Verificación final: si la página continúa mostrando bloqueo, insertar un banner visible
    try {
      const finalBlocked = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('no soy un robot') || text.includes("i'm not a robot") ||
          text.includes('unusual traffic') || text.includes('tráfico inusual');
      });

      if (finalBlocked) {
        console.warn('⚠️ La página sigue bloqueada — insertando mensaje en la página para evitar capturar el captcha.');
        await page.evaluate(() => {
          const banner = document.createElement('div');
          banner.style = 'position:fixed;left:0;right:0;top:0;padding:12px;font-weight:bold;background:#ffe9e9;color:#990000;z-index:99999;text-align:center;';
          banner.innerText = 'Contenido bloqueado por captcha — las imágenes podrían no estar disponibles.';
          document.body.insertBefore(banner, document.body.firstChild);
          window.scrollTo(0, 0);
        });
        await new Promise(r => setTimeout(r, 700));
      }
    } catch (err) {
      console.warn('⚠️ Error verificando bloqueo final:', err.message);
    }

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });

    console.log("✨ PDF generado exitosamente.");
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': pdfBuffer.length,
      'Content-Disposition': 'attachment; filename="reporte_ia.pdf"'
    });
    res.send(pdfBuffer);

  } catch (error) {
    console.error('❌ Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error generando PDF', details: error.message });
    }
  } finally {
    if (browser) await browser.close();
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

const server = app.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ Puerto ${PORT} en uso.`);
    process.exit(1);
  }
});
