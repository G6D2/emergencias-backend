const SENSITIVE_KEY = /^(authorization|cookie|access_token|refresh_token|password|latitude|longitude|location|location_encrypted|phone|emergencyContactName|emergencyContactPhone|medicalCondition|sensitive_encrypted)$/i;

function redactValue(key, value) {
  if (value == null) return value;

  if (SENSITIVE_KEY.test(key)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string' && /^Bearer\s+/i.test(value)) {
    return 'Bearer [REDACTED]';
  }

  // JWT-looking strings
  if (typeof value === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value)) {
    return '[REDACTED_JWT]';
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(String(index), item));
  }

  if (typeof value === 'object') {
    return redactObject(value);
  }

  return value;
}

function redactObject(input) {
  if (input == null || typeof input !== 'object') {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item, index) => redactValue(String(index), item));
  }

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = redactValue(key, value);
  }
  return out;
}

/** Resumen seguro para logs de eventos Kafka (sin coords ni tokens). */
function summarizeEventForLog(topic, value) {
  if (!value || typeof value !== 'object') {
    return { topic };
  }

  return {
    topic,
    type: value.type,
    emergencyId: value.emergencyId || value.id,
    status: value.status || value.newStatus,
    userId: value.userId,
    actor: value.actor,
    hasLocation: value.latitude != null || value.longitude != null
      || (value.location && (value.location.latitude != null || value.location.longitude != null)),
  };
}

function secureLog(level, message, meta) {
  const payload = meta === undefined ? '' : ` ${JSON.stringify(redactObject(meta))}`;
  if (level === 'error') {
    console.error(`${message}${payload}`);
  } else if (level === 'warn') {
    console.warn(`${message}${payload}`);
  } else {
    console.log(`${message}${payload}`);
  }
}

module.exports = {
  redactObject,
  summarizeEventForLog,
  secureLog,
};
