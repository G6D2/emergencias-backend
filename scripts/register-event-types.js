#!/usr/bin/env node
// Registra idempotentemente los event types del gateway EDA (ADR #25).
//
// Lee todos los schemas/eda/*.avsc.json (ignora .draft) y hace POST a
// ${EDA_API_URL}/api/v1/event-types con Bearer token obtenido via OAuth2
// client-credentials. Un "ya existe" (400) se trata como OK; cualquier otro
// error frena con exit 1.
//
// Uso:
//   EDA_API_URL=http://localhost:8080 \
//   EDA_AUTH_URL=http://localhost:8083/oauth/token \
//   EDA_CLIENT_ID=grupo5 EDA_CLIENT_SECRET=grupo5 \
//   node scripts/register-event-types.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const REQUIRED_ENV = ['EDA_API_URL', 'EDA_AUTH_URL', 'EDA_CLIENT_ID', 'EDA_CLIENT_SECRET'];
const SCHEMAS_DIR = path.join(process.cwd(), 'schemas', 'eda');
const ALREADY_EXISTS_RE = /existe un event type|already exists|duplicate/i;

function requireEnv(env = process.env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }
}

function listSchemaFiles(dir = SCHEMAS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.avsc.json'))
    .map((name) => path.join(dir, name))
    .sort();
}

function isAlreadyExistsResponse(status, body) {
  if (status !== 400) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  return ALREADY_EXISTS_RE.test(text);
}

async function getToken({ authUrl, clientId, clientSecret, fetchImpl = globalThis.fetch }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetchImpl(authUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Auth fallo (${response.status}): ${detail}`);
  }
  const payload = await response.json();
  if (!payload.access_token) throw new Error('Respuesta sin access_token');
  return payload.access_token;
}

async function registerSchema({ apiUrl, token, filePath, fetchImpl = globalThis.fetch }) {
  const name = path.basename(filePath, '.avsc.json');
  const body = fs.readFileSync(filePath, 'utf8');
  const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/api/v1/event-types`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  const text = await response.text().catch(() => '');
  if (response.status >= 200 && response.status < 300) {
    return { name, status: 'OK', httpCode: response.status };
  }
  if (isAlreadyExistsResponse(response.status, text)) {
    return { name, status: 'ALREADY_EXISTS', httpCode: response.status };
  }
  const err = new Error(`${name}: ${response.status} ${text}`);
  err.httpCode = response.status;
  err.body = text;
  throw err;
}

async function main() {
  requireEnv();
  const files = listSchemaFiles();
  if (files.length === 0) {
    console.log('No hay schemas .avsc.json en schemas/eda/. Nada que registrar.');
    return;
  }
  console.log(`Pidiendo token a ${process.env.EDA_AUTH_URL}...`);
  const token = await getToken({
    authUrl: process.env.EDA_AUTH_URL,
    clientId: process.env.EDA_CLIENT_ID,
    clientSecret: process.env.EDA_CLIENT_SECRET,
  });
  console.log(`Registrando ${files.length} schema(s) contra ${process.env.EDA_API_URL}...`);
  for (const file of files) {
    const result = await registerSchema({
      apiUrl: process.env.EDA_API_URL,
      token,
      filePath: file,
    });
    const tag = result.status === 'OK' ? 'OK' : 'YA EXISTE';
    console.log(`  [${tag}] ${result.name} (${result.httpCode})`);
  }
  console.log('Registro completado.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  requireEnv,
  listSchemaFiles,
  isAlreadyExistsResponse,
  getToken,
  registerSchema,
  REQUIRED_ENV,
  SCHEMAS_DIR,
};
