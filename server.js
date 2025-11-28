const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname), { index: false }));

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

app.post('/generar-pdf', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).send('Falta el query');

  let browser = null;

  try {
    console.log(`📄 Iniciando generación de PDF para: ${query}`);

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
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
      console.log('⚠️ Captcha detectado. Resolviendo con Anti-Captcha API REST...');

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

        const createTaskResponse = await axios.post('https://api.anti-captcha.com/createTask', {
          clientKey: '03ea83a89c837abf30695d43a93c0f29',
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
            clientKey: '03ea83a89c837abf30695d43a93c0f29',
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
          console.warn('⚠️ Advertencia: La página aún muestra bloqueo después de resolver el captcha.');
        } else {
          console.log('🎉 Desbloqueo exitoso! Página accesible.');
        }

      } catch (captchaError) {
        console.error('❌ Error resolviendo captcha:', captchaError.message);
      }
    } else {
      console.log('✅ No hay captcha. Continuando...');
    }

    await new Promise(r => setTimeout(r, 2000));

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

const server = app.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ Puerto ${PORT} en uso.`);
    process.exit(1);
  }
});
