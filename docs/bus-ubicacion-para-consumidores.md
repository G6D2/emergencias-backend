# Guía de ubicación en eventos de Emergencias (CityPass+)

Documento **autocontenido** para equipos que consumen `EmergenciaCreada` del bus (Reclamos, Analítica, Espacios, Movilidad, Residuos, etc.). No hace falta clonar el repo de Emergencias para usarlo.

---

## 1. Resumen

| Dato | Dónde viene | Forma |
|------|-------------|--------|
| Barrio | **Solo** `data.ubicacion.barrio` | Texto en claro (catálogo oficial CABA, 48 barrios) |
| Latitud / longitud | **Solo** `data.ubicacion.latitud` y `data.ubicacion.longitud` | String base64 cifrado (AES-256-GCM) |

Todo lo espacial va bajo `ubicacion`. No hay `barrio`, `latitud` ni `longitud` en la raíz de `data`.

Para desencriptar las coords necesitás la clave **`BUS_LOCATION_ENCRYPTION_KEY`**, distinta de la clave con la que Emergencias cifra en su base de datos. Esa clave de bus se reparte por canal seguro (no viaja en el mensaje).

---

## 2. Ejemplo de payload relevante

```json
{
  "type": "EmergenciaCreada",
  "eventId": "…",
  "correlationId": "…",
  "data": {
    "emergenciaId": "1d6bc592-…",
    "categoria": "PANICO",
    "prioridad": "CRITICA",
    "estado": "PENDIENTE",
    "ubicacion": {
      "barrio": "MONSERRAT",
      "latitud": "RUxDAQEx…",
      "longitud": "RUxDAQEx…"
    },
    "afectaCirculacion": null,
    "ciudadanoId": "…",
    "createdAt": "2026-11-05T22:33:33.481Z"
  }
}
```

Si no había coordenadas al crear la emergencia, o Emergencias no tiene configurada la clave de bus, `ubicacion.latitud` y `ubicacion.longitud` vienen `null`. El barrio puede existir igual (o ser `null` si el punto está fuera de CABA / no se pudo resolver).

---

## 3. Clave: qué pedir y qué no

| Nombre | Uso | ¿La reciben consumidores? |
|--------|-----|---------------------------|
| `BUS_LOCATION_ENCRYPTION_KEY` | Desencriptar coords del **bus** | **Sí** |
| `LOCATION_ENCRYPTION_KEY` | Cifrado interno de la DB de Emergencias | **No** |

- Formato: **32 bytes en base64** (un string tipo el de `openssl rand -base64 32`).
- Entrega: secrets del proyecto / 1Password / variables de entorno de staging-prod. **Nunca** pegar la clave en Slack, issues o repos públicos.
- Rotación (si aplica): pueden recibir un keyring `id:base64,id2:base64` y un `keyId` activo. El id de la clave usada está embebido en cada ciphertext.

---

## 4. Formato del ciphertext

Cada uno de `ubicacion.latitud` y `ubicacion.longitud` es un **string Base64** que decodifica a:

```
ELC (3 bytes ASCII "ELC")
|| version (1 byte, hoy = 1)
|| keyIdLen (1 byte)
|| keyId (keyIdLen bytes, ASCII)
|| iv (12 bytes)
|| authTag (16 bytes)
|| ciphertext (resto)
```

- Algoritmo: **AES-256-GCM**
- Clave: los 32 bytes decodificados de `BUS_LOCATION_ENCRYPTION_KEY` (o la entrada del keyring cuyo `keyId` coincide)
- Plaintext UTF-8 = JSON: `{"value": <number>}`  
  Ejemplo: `{"value":-34.615119}` → número `-34.615119`

Si falla el auth tag: clave incorrecta, ciphertext corrupto, o `keyId` que no tenés.

---

## 5. Código de ejemplo — Node.js

Snippet listo para copiar (solo usa el módulo `crypto` de Node; no depende del repo de Emergencias):

```js
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAGIC = Buffer.from('ELC', 'ascii');

function decryptBusCoordinate(ciphertextBase64, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('BUS_LOCATION_ENCRYPTION_KEY must decode to 32 bytes');
  }

  const payload = Buffer.from(ciphertextBase64, 'base64');
  if (payload.length < 5 || !payload.subarray(0, 3).equals(MAGIC)) {
    throw new Error('Invalid ciphertext: missing ELC header');
  }
  if (payload.readUInt8(3) !== 1) {
    throw new Error('Unsupported ciphertext version');
  }

  const keyIdLen = payload.readUInt8(4);
  const keyIdEnd = 5 + keyIdLen;
  const bodyStart = keyIdEnd + IV_LENGTH + AUTH_TAG_LENGTH;
  if (keyIdLen < 1 || payload.length <= bodyStart) {
    throw new Error('Invalid ciphertext length');
  }

  // keyId = payload.subarray(5, keyIdEnd).toString('ascii'); // útil con keyring
  const iv = payload.subarray(keyIdEnd, keyIdEnd + IV_LENGTH);
  const authTag = payload.subarray(keyIdEnd + IV_LENGTH, bodyStart);
  const encrypted = payload.subarray(bodyStart);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString('utf8'));
  const value = Number(parsed.value);
  if (!Number.isFinite(value)) {
    throw new Error('Invalid coordinate plaintext');
  }
  return value;
}

function coordsFromEmergenciaCreada(event, busKeyBase64) {
  const u = event?.data?.ubicacion;
  if (!u?.latitud || !u?.longitud) {
    return { latitude: null, longitude: null, barrio: u?.barrio ?? null };
  }
  return {
    latitude: decryptBusCoordinate(u.latitud, busKeyBase64),
    longitude: decryptBusCoordinate(u.longitud, busKeyBase64),
    barrio: u.barrio ?? null,
  };
}

// Uso:
// const coords = coordsFromEmergenciaCreada(mensajeKafka, process.env.BUS_LOCATION_ENCRYPTION_KEY);
```

### Python (equivalente)

```python
import base64
import json
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def decrypt_bus_coordinate(ciphertext_b64: str, key_b64: str) -> float:
    key = base64.b64decode(key_b64)
    if len(key) != 32:
        raise ValueError("key must be 32 bytes")
    payload = base64.b64decode(ciphertext_b64)
    if payload[:3] != b"ELC" or payload[3] != 1:
        raise ValueError("invalid header")
    key_id_len = payload[4]
    key_id_end = 5 + key_id_len
    iv = payload[key_id_end : key_id_end + 12]
    # AESGCM en cryptography espera nonce + ciphertext||tag, o decrypt separado:
    body = payload[key_id_end + 12 :]
    auth_tag, encrypted = body[:16], body[16:]
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, encrypted + auth_tag, None)
    return float(json.loads(plaintext.decode("utf-8"))["value"])
```

---

## 6. Barrio en claro vs coordenadas exactas

- **Barrio:** ubicación aproximada (uno de los 48 barrios oficiales de CABA). Alcanza para lógica por zona, métricas y muchos flujos. Preferilo si no necesitás el punto.
- **Lat/lng cifrados:** ubicación fina. Descifralos solo cuando el caso de uso lo exija. No los loguees en claro.

---

## 7. Si van a guardar estos datos (recomendaciones)

El mensaje en Kafka **no se borra solo**. Si ustedes persisten barrio y/o coordenadas en su base, la minimización es **responsabilidad de su módulo**. Orientación:

| Qué guardan | Recomendación |
|-------------|---------------|
| Solo `barrio` | Dato agregado: riesgo menor. Pueden conservarlo para métricas/zonas; igual eviten cruzarlo con identidad de ciudadano más tiempo del necesario. |
| Lat/lng desencriptados (plaintext) | Tratarlos como PII de ubicación fina. **No** los dejen indefinidos: borren o anonimicen tras un plazo corto (p. ej. alineado a **72 h post-cierre** del caso, o desde que ustedes consideren el incidente resuelto). |
| Ciphertext del bus (`ubicacion.latitud/longitud`) | Sigue siendo ubicación si tienen la clave. Apliquen el mismo plazo de borrado, o no los persistan y desencripten solo en memoria al procesar. |
| Logs | Nunca loguear coords en claro, ni la `BUS_LOCATION_ENCRYPTION_KEY`, ni el ciphertext completo en logs de larga retención. |

Prácticas concretas:

1. **Preferir barrio** si el caso de uso no necesita el punto exacto.  
2. Si necesitan lat/lng: desencriptar → usar → **no guardar**, o guardar con TTL y job de borrado.  
3. Tras el TTL: poner coords en `NULL` (o borrar la fila de ubicación); el resto del evento/caso puede quedar.  
4. Documenten en su módulo el plazo elegido y quién opera el job.  
5. Referencia de Emergencias (solo contexto): en *su* DB, Emergencias anonimiza la ubicación exacta ~72 h después del cierre y **conserva** el barrio. Ustedes no heredan ese job automáticamente.

---

## 8. Checklist rápido

1. Pedir `BUS_LOCATION_ENCRYPTION_KEY` por canal seguro.  
2. Consumir `EmergenciaCreada` y leer `data.ubicacion`.  
3. Si `latitud`/`longitud` son `null` → no hay punto exacto.  
4. Descifrar con AES-256-GCM según la sección 4–5.  
5. Usar `barrio` en claro cuando baste.  
6. No loguear coords en claro ni la clave.  
7. Si persisten ubicación: definir TTL + borrado/anonimización (sección 7).

---

## 9. Contacto

Grupo 6 — módulo Emergencias (CityPass+). Ante dudas de contrato o rotación de clave, escribir al canal / board del grupo.
