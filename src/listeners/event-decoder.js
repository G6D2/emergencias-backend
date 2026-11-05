const { SchemaRegistry } = require('@kafkajs/confluent-schema-registry');

// Decodifica el value de un mensaje de Kafka a { metadata, data }.
//
// El gateway del Grupo 1 escribe en formato Confluent:
// [0x00][schemaId: 4 bytes big-endian][Avro binario]. El schema se resuelve
// contra el registry (el gateway responde /schemas/ids/{id} en
// `${EDA_SCHEMA_REGISTRY_URL}`, sección 6 de su README).
//
// Un mensaje que no empieza con 0x00 se lee como JSON: es lo que mandan los
// tests y un Kafka local sin gateway.
//
// Un mensaje ilegible lanza un error marcado como permanente (no tiene
// sentido reintentarlo). Un registry inalcanzable queda como transitorio
// (ver error-classifier.js).
const MAGIC_BYTE = 0;

function permanent(message, cause) {
  const error = new Error(message);
  error.permanent = true;
  if (cause) error.cause = cause;
  return error;
}

// El registry caído, saturado o mal configurado (401/403) se reintenta: el
// evento está bien y va a poder leerse. Un schema inexistente (404) o un
// payload que no matchea su schema no se arreglan reintentando.
function isRegistryUnavailable(error) {
  const status = Number(error.status);
  if (status) return status >= 500 || status === 429 || status === 401 || status === 403;
  return Boolean(error.code) || /fetch failed|timeout|ECONN|socket/i.test(String(error.message));
}

function registryFromEnv(env = process.env) {
  const host = env.EDA_SCHEMA_REGISTRY_URL;
  if (!host) return null;
  const options = { host };
  if (env.EDA_SCHEMA_REGISTRY_USERNAME && env.EDA_SCHEMA_REGISTRY_PASSWORD) {
    options.auth = {
      username: env.EDA_SCHEMA_REGISTRY_USERNAME,
      password: env.EDA_SCHEMA_REGISTRY_PASSWORD,
    };
  }
  return new SchemaRegistry(options);
}

function createEventDecoder({ registry = null } = {}) {
  return {
    async decode(value) {
      if (!value || value.length === 0) {
        throw permanent('mensaje vacío');
      }
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);

      if (buffer[0] === MAGIC_BYTE) {
        if (!registry) {
          throw permanent('mensaje Avro sin EDA_SCHEMA_REGISTRY_URL configurado');
        }
        try {
          return await registry.decode(buffer);
        } catch (error) {
          if (isRegistryUnavailable(error)) {
            error.transient = true;
            throw error;
          }
          throw permanent(`Avro inválido: ${error.message}`, error);
        }
      }

      try {
        return JSON.parse(buffer.toString('utf8'));
      } catch (error) {
        throw permanent(`JSON inválido: ${error.message}`, error);
      }
    },
  };
}

module.exports = { createEventDecoder, registryFromEnv, MAGIC_BYTE };
