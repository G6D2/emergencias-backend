const path = require('path');
const express = require('express');

// Pagina de documentacion del contrato de eventos (asyncapi.yaml), al lado de
// Swagger (/api-docs). El viewer oficial de AsyncAPI se carga del CDN con
// version fija: no suma dependencias al backend ni paso de build.
const SPEC_PATH = path.resolve(__dirname, '..', '..', 'asyncapi.yaml');
const VIEWER_VERSION = '3.2.2';
const VIEWER_BASE = `https://cdn.jsdelivr.net/npm/@asyncapi/react-component@${VIEWER_VERSION}`;

function renderPage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Emergencias Eventos Docs</title>
  <link rel="stylesheet" href="${VIEWER_BASE}/styles/default.min.css">
  <style>
    /* Look & feel cercano a Swagger UI (/api-docs). El viewer no fija
       tipografia global: sin esto cae en serif. */
    :root {
      /* Mismos colores que los badges SEND (azul) y RECEIVE (verde) del viewer,
         con la paleta de los bloques GET/POST de Swagger. */
      --send: #61affe;
      --send-bg: rgba(97, 175, 254, .1);
      --receive: #49cc90;
      --receive-bg: rgba(73, 204, 144, .1);
      --ink: #3b4151;
    }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      background: #fff;
      color: var(--ink);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
    }
    .docs-header {
      position: sticky; top: 0; z-index: 40; box-sizing: border-box; height: 52px;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 0 16px; background: #1b1b1b; color: #fff; font-size: 14px;
    }
    .docs-header .brand { display: flex; align-items: baseline; gap: 8px; font-weight: 700; white-space: nowrap; }
    .docs-header .brand small { font-weight: 400; color: #ccc; }
    .docs-header .brand span { color: #89bf04; }
    .docs-header nav { display: flex; gap: 8px; }
    .docs-header a {
      color: #fff; text-decoration: none; padding: 6px 10px; border: 1px solid #89bf04; border-radius: 4px;
    }
    .docs-header a:hover { background: #89bf04; color: #1b1b1b; }
    .docs-loading { padding: 16px; }

    .aui-root { color: var(--ink); }
    /* Codigo inline: pill gris como Swagger, sin los backticks del tema. */
    .aui-root .prose code::before, .aui-root .prose code::after { content: none; }
    .aui-root .prose code {
      background: rgba(0, 0, 0, .05); border-radius: 4px; padding: 1px 5px;
      font-weight: 600; font-size: .85em; color: #3b4151;
    }

    /* Cada operacion como bloque de Swagger: verde si publicamos, azul si consumimos. */
    .aui-root li[id^="operation-"] {
      border: 1px solid var(--receive); background: var(--receive-bg);
      border-radius: 4px; padding: 16px 0; margin: 0 32px 24px; overflow: hidden;
      box-shadow: 0 0 3px rgba(0, 0, 0, .19);
    }
    .aui-root li[id^="operation-send-"] { border-color: var(--send); background: var(--send-bg); }
    .aui-root li[id^="operation-"] .panel-item--center { padding-left: 16px; padding-right: 16px; }
    .aui-root li[id^="operation-"] p.px-8 { padding-left: 16px; padding-right: 16px; }
    .aui-root li[id^="operation-"] .examples { margin-left: 0; margin-right: 0; border-radius: 0; }
    .aui-root li[id^="operation-"] .bg-gray-100,
    .aui-root li[id^="operation-"] .bg-gray-200 { background: rgba(255, 255, 255, .7); }

    /* Sidebar: los operationId largos entran en una linea. */
    .aui-root .sidebar .break-all { word-break: normal; overflow-wrap: anywhere; font-size: 12.5px; }
    /* Nombres largos (URL del server, FQN del evento) cortan en vez de
       ensanchar la pagina en el celular. */
    .aui-root .font-mono { overflow-wrap: anywhere; }
    .aui-root h3 strong, .aui-root h4 strong { white-space: nowrap; }

    /* El viewer solo fija el sidebar por encima de 1536px de ancho y debajo usa
       el boton flotante. Se repiten sus propias reglas desde 1024px para que en
       una laptop el indice quede visible, debajo del header sticky (52px). */
    @media (min-width: 1024px) {
      .aui-root .container\\:xl .burger-menu { display: none; }
      .aui-root .container\\:xl .sidebar { position: relative; display: block; height: auto; width: 18rem; }
      .aui-root .container\\:xl .sidebar--content { width: 16rem; }
      .aui-root .container\\:base .sidebar { width: 18rem; }
      .aui-root .container\\:base .sidebar--content { width: 16rem; }
      .aui-root .sidebar > div { top: 52px; max-height: calc(100vh - 52px); }
    }
    /* El viewer elige el layout por el ancho de su propio contenedor: por encima
       de 1536px pasa a 3 columnas (ejemplos en un panel oscuro a la derecha).
       Con el ancho tope de Swagger UI queda siempre en una columna, con los
       ejemplos dentro de cada operacion. */
    .aui-root { max-width: 1460px; margin: 0 auto; }
    @media (max-width: 639px) {
      .aui-root li[id^="operation-"] { margin-left: 12px; margin-right: 12px; }
      .docs-header .brand small { display: none; }
    }
  </style>
</head>
<body>
  <header class="docs-header">
    <div class="brand"><span>AsyncAPI</span> Emergencias <small>· contrato de eventos</small></div>
    <nav><a href="/api-docs">API REST</a><a href="/asyncapi.yaml">YAML</a></nav>
  </header>
  <div id="asyncapi"><p class="docs-loading">Cargando spec AsyncAPI…</p></div>
  <script src="${VIEWER_BASE}/browser/standalone/index.js"></script>
  <script>
    AsyncApiStandalone.render({
      schema: { url: '/asyncapi.yaml' },
      config: {
        show: { sidebar: true, messageExamples: true },
        expand: { messageExamples: true },
      },
    }, document.getElementById('asyncapi'));
  </script>
</body>
</html>
`;
}

/**
 * GET /asyncapi       -> pagina con el viewer de AsyncAPI
 * GET /asyncapi.yaml  -> spec crudo (lo lee el viewer; sirve para Studio o codegen)
 */
function createAsyncApiRoutes({ specPath = SPEC_PATH } = {}) {
  const router = express.Router();
  const page = renderPage();

  router.get('/asyncapi.yaml', (req, res, next) => {
    // El header va en las opciones: si el archivo falta, el handler de errores
    // responde con su propio Content-Type.
    res.sendFile(specPath, { headers: { 'Content-Type': 'application/yaml; charset=utf-8' } }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  // Express (strict routing apagado) tambien atiende /asyncapi/ aca.
  router.get('/asyncapi', (req, res) => {
    res.type('html').send(page);
  });

  return router;
}

module.exports = { createAsyncApiRoutes, VIEWER_VERSION };
