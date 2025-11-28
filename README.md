## Proxies y rotación

Si tienes bloqueos por IP, puedes proporcionar una lista de proxies separadas por comas usando la variable `PROXY_LIST` (ej: `http://user:pass@1.2.3.4:8080,http://1.2.3.5:8080`). La app elegirá un proxy al azar por petición y configurará autenticación si el proxy incluye credenciales.

## Rate limiting

Para evitar disparar protecciones por demasiadas peticiones, se añadió limitación por IP en la ruta `POST /generar-pdf`. Puedes configurar:

- RATE_LIMIT_WINDOW_MS (por defecto 60000 ms)
- RATE_LIMIT_MAX (por defecto 6 requests por ventana)

Puedes ajustar estas variables en Render.com o en tu `.env`.
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

Hemos incluido un `.env.example` como referencia — pon allí tu `ANTI_CAPTCHA_KEY` en desarrollo local.

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