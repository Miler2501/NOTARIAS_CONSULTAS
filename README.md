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
   npm install express puppeteer pdf-lib
   ```
2. Ejecuta el servidor:
   ```bash
   node server.js
   ```
3. Abre en tu navegador:
   [http://localhost:3000/](http://localhost:3000/)

## Notas
- Si quieres usar la versión PHP, usa XAMPP/WAMP y accede a `buscador_legacy.php`.
- Si Puppeteer da error en Windows, instala dependencias de Chromium o usa la opción `puppeteer-core` con Chrome instalado.
- El backend genera un PDF con la búsqueda de Google al finalizar el loading.

## Archivos importantes
- `buscador.html`: Usar siempre este archivo con Node.js.
- `buscador_legacy.php`: Solo referencia, no funcional con Node.js.
- `server.js`: Backend Node.js.

---
Cualquier duda, consulta el código o pide ayuda para la configuración.