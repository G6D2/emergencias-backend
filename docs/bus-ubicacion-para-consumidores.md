# Guía de ubicación en eventos de Emergencias (CityPass+)

Documento **autocontenido** para equipos que consumen `EmergenciaCreada` y `EmergenciaActualizada` del bus (Reclamos, Analítica, Espacios, Movilidad, Residuos, etc.). No hace falta clonar el repo de Emergencias para usarlo.

---

## 1. Resumen

| Dato | Dónde viene | Forma |
|------|-------------|--------|
| Barrio | `data.barrio` **y** `data.ubicacion.barrio` (mismo valor) | Texto en claro (catálogo oficial CABA, 48 barrios) |
| Latitud / longitud aproximadas | `data.latitud` y `data.longitud`, en ambos eventos | Número en claro, 3 decimales (~100 m) |
| Latitud / longitud exactas | `data.ubicacion.latitud` y `data.ubicacion.longitud`, en ambos eventos | String base64 cifrado (AES-256-GCM) |

Desde el 12/11/2026, `data.latitud` y `data.longitud` van además **en la raíz, como número en claro redondeado a 3 decimales (~100 m)**. Si solo necesitás ubicar la emergencia en el mapa o calcular un radio, usá esas y no hace falta descifrar nada. La coordenada exacta sigue cifrada en `data.ubicacion`. Las dos de la raíz son `null` cuando la emergencia no tiene ubicación.

Para desencriptar las coords necesitás la clave **`BUS_LOCATION_ENCRYPTION_KEY`**, distinta de la clave con la que Emergencias cifra en su base de datos. Esa clave de bus se reparte por canal seguro (no viaja en el mensaje).

---

## 2. Ejemplo de payload relevante

```json
{
  "type": "EmergenciaCreada",
  "eventId": "…",
  "correlationId": "5d1e9a7c-…",
  "data": {
    "emergenciaId": "5d1e9a7c-…",
    "categoria": "PANICO",
    "prioridad": "CRITICA",
    "estado": "PENDIENTE",
    "barrio": "MONSERRAT",
    "ubicacion": {
      "barrio": "MONSERRAT",
      "latitud": "RUxDAQEx…",
      "longitud": "RUxDAQEx…"
    },
    "afectaCirculacion": null,
    "causaId": null,
    "causaTipo": null,
    "prioridadOriginal": null,
    "ciudadanoId": "CIT-…",
    "correlationId": "5d1e9a7c-…",
    "createdAt": "2026-11-05T22:33:33.481Z"
  }
}
```

Si no había coordenadas al crear, o Emergencias no tiene clave de bus, `ubicacion.latitud` / `longitud` vienen `null`. El barrio puede existir igual (o ser `null` si no se pudo resolver).

---

## 3. Clave: qué pedir y qué no

| Nombre | Uso | ¿La reciben consumidores? |
|--------|-----|---------------------------|
| `BUS_LOCATION_ENCRYPTION_KEY` | Desencriptar coords del **bus** | **Sí** |
| `LOCATION_ENCRYPTION_KEY` | Cifrado interno de la DB de Emergencias | **No** |

- Formato: **32 bytes en base64**.
- Entrega: secrets del proyecto / 1Password / env de staging-prod. **Nunca** en Slack, issues o repos.
- Rotación (si aplica): keyring `id:base64,…` + `BUS_LOCATION_ENCRYPTION_KEY_ID`.

---

## 4. Formato del ciphertext

Cada campo es Base64 de:

```
ELC (3 bytes) || version (1, =1) || keyIdLen (1) || keyId || iv (12) || authTag (16) || ciphertext
```

- Algoritmo: **AES-256-GCM**
- Plaintext UTF-8: `{"value": <number>}`
- **AAD (obligatorio):**  
  - latitud → `"{emergenciaId}|latitud"`  
  - longitud → `"{emergenciaId}|longitud"`  
  Usá el `data.emergenciaId` del mismo evento. Así no se pueden intercambiar lat/lng ni reusar un ciphertext en otro evento.

---

## 5. Código de ejemplo — Node.js

```js
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAGIC = Buffer.from('ELC', 'ascii');

function decryptBusCoordinate(ciphertextBase64, keyBase64, { emergencyId, field }) {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('key must decode to 32 bytes');
  if (!emergencyId || !field) throw new Error('AAD requires emergencyId and field');

  const payload = Buffer.from(ciphertextBase64, 'base64');
  if (payload.length < 5 || !payload.subarray(0, 3).equals(MAGIC)) {
    throw new Error('Invalid ciphertext: missing ELC header');
  }
  if (payload.readUInt8(3) !== 1) throw new Error('Unsupported version');

  const keyIdLen = payload.readUInt8(4);
  const keyIdEnd = 5 + keyIdLen;
  const bodyStart = keyIdEnd + IV_LENGTH + AUTH_TAG_LENGTH;
  if (keyIdLen < 1 || payload.length <= bodyStart) throw new Error('Invalid length');

  const iv = payload.subarray(keyIdEnd, keyIdEnd + IV_LENGTH);
  const authTag = payload.subarray(keyIdEnd + IV_LENGTH, bodyStart);
  const encrypted = payload.subarray(bodyStart);
  const aad = Buffer.from(`${emergencyId}|${field}`, 'utf8');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const value = Number(JSON.parse(plaintext.toString('utf8')).value);
  if (!Number.isFinite(value)) throw new Error('Invalid plaintext');
  return value;
}

function coordsFromEmergenciaCreada(event, busKeyBase64) {
  const data = event?.data || {};
  const u = data.ubicacion || {};
  const emergencyId = data.emergenciaId;
  const barrio = data.barrio ?? u.barrio ?? null;
  if (!u.latitud || !u.longitud) {
    return { latitude: null, longitude: null, barrio };
  }
  return {
    latitude: decryptBusCoordinate(u.latitud, busKeyBase64, { emergencyId, field: 'latitud' }),
    longitude: decryptBusCoordinate(u.longitud, busKeyBase64, { emergencyId, field: 'longitud' }),
    barrio,
  };
}
```

### Python (equivalente)

```python
import base64, json
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def decrypt_bus_coordinate(ciphertext_b64, key_b64, emergency_id, field):
    key = base64.b64decode(key_b64)
    payload = base64.b64decode(ciphertext_b64)
    assert payload[:3] == b"ELC" and payload[3] == 1
    key_id_len = payload[4]
    key_id_end = 5 + key_id_len
    iv = payload[key_id_end:key_id_end + 12]
    body = payload[key_id_end + 12:]
    auth_tag, encrypted = body[:16], body[16:]
    aad = f"{emergency_id}|{field}".encode("utf-8")
    plaintext = AESGCM(key).decrypt(iv, encrypted + auth_tag, aad)
    return float(json.loads(plaintext.decode("utf-8"))["value"])
```

---

## 6. Barrio en claro vs coordenadas exactas

- **Barrio:** zona agregada (48 oficiales). Preferilo para lógica por zona.  
- **Lat/lng cifrados:** ubicación fina. Descifralos solo si hace falta. No los loguees en claro.

---

## 7. Si van a guardar estos datos (recomendaciones)

El mensaje en Kafka **no se borra solo**. Si ustedes persisten barrio y/o coordenadas:

| Qué guardan | Recomendación |
|-------------|---------------|
| Solo `barrio` | Dato agregado: riesgo menor; igual limitá cruce con identidad. |
| Lat/lng desencriptados | PII fina: borrá/anonimizá tras un plazo corto (p. ej. ~72 h post-cierre). |
| Ciphertext del bus | Sigue siendo ubicación si tienen la clave: mismo TTL, o no persistir. |
| Logs | Nunca coords en claro ni la clave de bus. |

**Qué hace Emergencias (referencia):** anonimiza la ubicación exacta at-rest ~72 h después del cierre y **conserva** el barrio. Al anonimizar, también pone en `null`, en los payloads del **outbox** de esas emergencias, `ubicacion.latitud`/`longitud` (para que no queden ciphertext descifrables indefinidamente con la clave compartida) y las aproximadas en claro `data.latitud`/`data.longitud`. Los mensajes **ya consumidos** en su sistema no se reescriben: la retención de lo que ustedes guardaron es responsabilidad de su módulo.

---

## 8. Checklist rápido

1. Pedir `BUS_LOCATION_ENCRYPTION_KEY` por canal seguro.  
2. Leer `data.barrio`, `data.latitud` / `data.longitud` (aproximadas, en claro) y, si hace falta la exacta, `data.ubicacion` (cifrada).  
3. Si lat/lng son `null` → no hay punto exacto.  
4. Descifrar con AAD `emergenciaId|latitud` / `|longitud`.  
5. Preferir barrio cuando baste.  
6. Si persisten ubicación: TTL + borrado (sección 7).

---

## 9. Contacto

Grupo 6 — módulo Emergencias (CityPass+).
