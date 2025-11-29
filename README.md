## Proxies y rotación

Si tienes bloqueos por IP, puedes proporcionar una lista de proxies separadas por comas usando la variable `PROXY_LIST` (ej: `http://user:pass@1.2.3.4:8080,http://1.2.3.5:8080`). La app elegirá un proxy al azar por petición y configurará autenticación si el proxy incluye credenciales.

## Rate limiting

Para evitar disparar protecciones por demasiadas peticiones, se añadió limitación por IP en la ruta `POST /generar-pdf`. Puedes configurar:

- RATE_LIMIT_WINDOW_MS (por defecto 60000 ms)
- RATE_LIMIT_MAX (por defecto 6 requests por ventana)

Puedes ajustar estas variables en Render.com o en tu `.env`.

## Retries, backoff y diagnóstico

Para mejorar la probabilidad de obtener resultados cuando Google bloquea por IP, la app soporta retries con rotación de proxies y backoff:

- MAX_RETRIES — número máximo de reintentos (default 3)
- RETRY_DELAY_MS — base de espera entre reintentos en ms (default 1500)
- BACKOFF_MULT — multiplicador de backoff (default 1.8)

También incluimos un endpoint de telemetría `/status` y un endpoint `/debug-captcha?query=...` para diagnosticar si una búsqueda muestra captcha y obtener el sitekey. Revisa `logs/telemetry.log` en el servidor para el histórico de intentos.

Si quieres usar el plugin integrado `puppeteer-extra-plugin-recaptcha` en lugar del flujo REST manual, activa `USE_RECAPTCHA_PLUGIN=true` en producción (requiere `ANTI_CAPTCHA_KEY`).
# Buscador de Páginas (Node.js + HTML)

## Estructura
- `buscador.html`: Interfaz principal, lista y animaciones, sin PHP.
- `server.js`: Servidor Node.js (Express) que sirve el HTML y genera PDFs con Puppeteer.
- `buscador_legacy.php`: Versión original en PHP (solo para referencia, no se usa con Node.js).
- Archivos PDF: Descargables según el tipo y número de documento.

## Requisitos
- Node.js instalado

## Instalación
1. Instala dependencias:
   ```bash
   npm install
   ```
2. Ejecuta el servidor:
   ```bash
   node server.js
   ```
3. Abre en tu navegador:
   [http://localhost:3000/](http://localhost:3000/)

## Anti-Captcha (REQUIRED for automated captcha solving)

Esta aplicación requiere una clave válida de Anti-Captcha (`ANTI_CAPTCHA_KEY`) en las variables de entorno para poder resolver reCAPTCHA automáticamente. Por seguridad la key ya no se encuentra embebida en el código: **debes** configurar `ANTI_CAPTCHA_KEY` en tu entorno (por ejemplo Render.com o un archivo `.env`) antes de arrancar la aplicación.

Cómo configurarlo en Render.com:

1. Entra en tu servicio en Render -> Settings -> Environment -> Environment Variables.
2. Añade `ANTI_CAPTCHA_KEY` como key y el valor de tu clientKey.
3. Reinicia el servicio para que tome la variable.

También puedes usar un archivo `.env` local (no lo subas al repositorio):

```text
ANTI_CAPTCHA_KEY=tu_client_key_aqui
```

Hemos incluido un `.env.example` como referencia — **no** pongas claves reales en archivos rastreados por git.
En local copia `.env.example` a `.env` y añade tu `ANTI_CAPTCHA_KEY` allí (este repo ya ignora `.env`).
Si compartiste tu clave en público (por ejemplo en un chat), te recomiendo rotarla por seguridad.

## Despliegue en Render.com (cheklist rápido)

- Asegúrate de que tu servicio en Render use Node.js >= 18 (en `Environment` > `Runtime`).
- Configura estas variables en Render -> Settings -> Environment -> Environment Variables:
   - `ANTI_CAPTCHA_KEY` — tu clientKey de Anti-Captcha (obligatoria si ANTI_CAPTCHA_REQUIRED=true)
   - `ANTI_CAPTCHA_REQUIRED` — true (default) o false para desarrollo sin key
   - `PROXY_LIST` — (opcional) lista de proxies separados por comas
   - `PARALLEL_CONCURRENCY`, `MAX_RETRIES`, `RATE_LIMIT_*` según necesidades
- Start Command en Render: `npm start` (ya definido en package.json)
- Verifica que la instancia tenga recursos para ejecutar Puppeteer/Chromium; si hay errores de Chromium revisa los logs y añade las dependencias del sistema si hace falta.

## Endpoints útiles para operaciones y diagnóstico

- `POST /generar-pdf` — ruta principal protegida por rate-limit para generar PDF.
- `GET /debug-captcha?query=...` — revisa si una búsqueda genera captcha y devuelve siteKey.
- `GET /debug-captcha?query=...` — revisa si una búsqueda genera captcha y devuelve siteKey.
- `GET /api/dni/:dni` — búsqueda de DNI. Por defecto devuelve un mock; si configuras `DNI_API_URL` y (opcional) `DNI_API_SEED` la app reenviará la consulta a ese servicio y devolverá su resultado.
- `GET /status` — estado/telemetría: intentos, pool de proxies, si la key está configurada.
- `GET /proxy-health` — lanza una comprobación de salud de proxies listados en `PROXY_LIST`.

## Notas
- Si quieres usar la versión PHP, usa XAMPP/WAMP y accede a `buscador_legacy.php`.
- Si Puppeteer da error en Windows, instala dependencias de Chromium o usa la opción `puppeteer-core` con Chrome instalado.
- El backend genera un PDF con la búsqueda de Google al finalizar el loading.

## Archivos importantes
- `buscador.html`: Usar siempre este archivo con Node.js.
- `buscador_legacy.php`: Solo referencia, no funcional con Node.js.
- `server.js`: Backend Node.js.

## Cómo evita capturar el captcha

El servidor detecta cuando Google muestra un captcha e intentará resolverlo usando Anti-Captcha mediante la variable de entorno `ANTI_CAPTCHA_KEY` (obligatoria). Después de la resolución (o si no se puede resolver), el servidor intentará ocultar o eliminar overlays de captcha antes de generar el PDF para evitar que el captcha aparezca en la captura. Si la página continúa bloqueada, el PDF mostrará un mensaje de "Imagen no disponible: captcha detectado o bloqueado." en lugar del contenido.

---
Cualquier duda, consulta el código o pide ayuda para la configuración.