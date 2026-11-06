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
</head>
<body>
  <div id="asyncapi"><p style="font-family:sans-serif;padding:16px">Cargando spec AsyncAPI…
    (<a href="/asyncapi.yaml">ver YAML</a>)</p></div>
  <script src="${VIEWER_BASE}/browser/standalone/index.js"></script>
  <script>
    AsyncApiStandalone.render({
      schema: { url: '/asyncapi.yaml' },
      config: { show: { sidebar: true } },
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
