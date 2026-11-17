// Contextos de zona (ADR "Elevar la prioridad con contextos de zona por radio
// o por barrio", migraciones V28, V31 y V33). Un contexto vigente sube un
// nivel la prioridad de despacho de las emergencias que alcanza su zona:
// - Punto + radio (eventos comunitarios, V31): las emergencias creadas a no
//   más de radio_metros del punto.
// - Barrios (alertas climáticas, V33): las emergencias abiertas de esos
//   barrios, sin importar cuándo se crearon.
// Si tiene tipos_emergencia, solo eleva esos tipos (NULL = todos). El vínculo
// y el cálculo viven en emergency.repository.js; acá solo se dan de alta y de
// baja, y se listan los activos para el banner del tablero.
//
// Orden de llegada (Kafka reentrega y desordena):
// - Un alta más vieja que lo guardado no pisa nada: ni por source_updated_at
//   ni, si las dos la traen, por version_origen.
// - La baja es lógica y definitiva: un alta posterior no revive el contexto.
// - La suspensión es reversible: cada alta dice si el evento está suspendido
//   y la reanudación limpia la marca.
// - Una baja sin alta previa deja una fila ya dada de baja, así el alta
//   tardía se ignora.
// Una escritura que no aplica es un resultado normal, no un error.

function mapContextoZona(row) {
  if (!row) return null;
  return {
    id: row.id,
    tipo: row.tipo,
    latitud: row.latitud ?? null,
    longitud: row.longitud ?? null,
    radioMetros: row.radio_metros ?? null,
    barrios: row.barrios ?? null,
    tiposEmergencia: row.tipos_emergencia ?? null,
    fenomeno: row.fenomeno ?? null,
    gravedad: row.gravedad ?? null,
    versionOrigen: row.version_origen ?? null,
    vigenteDesde: row.vigente_desde,
    vigenteHasta: row.vigente_hasta,
    origen: row.origen,
    referenciaExterna: row.referencia_externa,
    descripcion: row.descripcion,
    causationId: row.causation_id,
    sourceUpdatedAt: row.source_updated_at,
    suspendidoEn: row.suspendido_en ?? null,
    dadoDeBajaEn: row.dado_de_baja_en,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class ContextoZonaRepository {
  constructor(pool) {
    this.pool = pool;
  }

  // Alta o actualización. Devuelve el contexto si la escritura aplicó, o
  // null si se ignoró (más vieja que lo guardado, o contexto dado de baja).
  // - suspendido: marca o limpia la suspensión (se conserva la fecha de la
  //   primera vez que se suspendió).
  // - ventanaPorDefecto: la ventana no vino en el evento; en un contexto que
  //   ya existe se conserva la guardada.
  // - barrios, tiposEmergencia, fenomeno, gravedad, versionOrigen: los usa la
  //   alerta climática. Los eventos comunitarios no los mandan y quedan NULL.
  async upsert(executor, {
    tipo, latitud, longitud, radioMetros, vigenteDesde, vigenteHasta, origen, referenciaExterna,
    descripcion = null, causationId = null, sourceUpdatedAt,
    suspendido = false, ventanaPorDefecto = false,
    barrios = null, tiposEmergencia = null, fenomeno = null, gravedad = null, versionOrigen = null,
  }) {
    const client = executor || this.pool;
    const result = await client.query(
      `INSERT INTO contexto_zona
         (tipo, latitud, longitud, radio_metros, vigente_desde, vigente_hasta, origen, referencia_externa,
          descripcion, causation_id, source_updated_at, suspendido_en,
          barrios, tipos_emergencia, fenomeno, gravedad, version_origen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12::boolean THEN now() END,
               $14::text[], $15::text[], $16, $17, $18)
       ON CONFLICT (tipo, origen, referencia_externa) DO UPDATE
         SET latitud = EXCLUDED.latitud,
             longitud = EXCLUDED.longitud,
             radio_metros = EXCLUDED.radio_metros,
             barrios = EXCLUDED.barrios,
             tipos_emergencia = EXCLUDED.tipos_emergencia,
             fenomeno = EXCLUDED.fenomeno,
             gravedad = EXCLUDED.gravedad,
             version_origen = EXCLUDED.version_origen,
             vigente_desde = CASE WHEN $13::boolean THEN contexto_zona.vigente_desde ELSE EXCLUDED.vigente_desde END,
             vigente_hasta = CASE WHEN $13::boolean THEN contexto_zona.vigente_hasta ELSE EXCLUDED.vigente_hasta END,
             suspendido_en = CASE WHEN $12::boolean THEN COALESCE(contexto_zona.suspendido_en, now()) END,
             descripcion = EXCLUDED.descripcion,
             causation_id = EXCLUDED.causation_id,
             source_updated_at = EXCLUDED.source_updated_at,
             updated_at = now()
         WHERE contexto_zona.dado_de_baja_en IS NULL
           AND contexto_zona.source_updated_at <= EXCLUDED.source_updated_at
           AND (contexto_zona.version_origen IS NULL OR EXCLUDED.version_origen IS NULL
                OR contexto_zona.version_origen <= EXCLUDED.version_origen)
       RETURNING *`,
      [tipo, latitud, longitud, radioMetros, vigenteDesde, vigenteHasta, origen, referenciaExterna,
        descripcion, causationId, sourceUpdatedAt, Boolean(suspendido), Boolean(ventanaPorDefecto),
        barrios, tiposEmergencia, fenomeno, gravedad, versionOrigen]
    );
    return mapContextoZona(result.rows[0]);
  }

  // Contextos activos o por empezar, para el banner del tablero: no dados de
  // baja, no suspendidos y sin vencer. Incluye los que todavía no empezaron
  // (vigente_desde en el futuro) para que el banner diga "desde las 18:00".
  // Usa now() de la base, como la lectura de la prioridad. Sin tipo, trae
  // todos.
  async findActivos(executor, { tipo = null } = {}) {
    const client = executor || this.pool;
    const result = await client.query(
      `SELECT * FROM contexto_zona
       WHERE dado_de_baja_en IS NULL
         AND suspendido_en IS NULL
         AND vigente_hasta > now()
         AND ($1::text IS NULL OR tipo = $1::text)
       ORDER BY vigente_desde ASC, created_at ASC`,
      [tipo]
    );
    return result.rows.map(mapContextoZona);
  }

  // Baja lógica. Devuelve el contexto si esta llamada lo dio de baja (o dejó
  // la marca para un alta que todavía no llegó), o null si ya estaba de baja.
  async darDeBaja(executor, {
    tipo, origen, referenciaExterna, causationId = null, sourceUpdatedAt,
  }) {
    const client = executor || this.pool;
    const result = await client.query(
      `INSERT INTO contexto_zona
         (tipo, origen, referencia_externa, causation_id, source_updated_at, dado_de_baja_en)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tipo, origen, referencia_externa) DO UPDATE
         SET dado_de_baja_en = now(),
             source_updated_at = GREATEST(contexto_zona.source_updated_at, EXCLUDED.source_updated_at),
             updated_at = now()
         WHERE contexto_zona.dado_de_baja_en IS NULL
       RETURNING *`,
      [tipo, origen, referenciaExterna, causationId, sourceUpdatedAt]
    );
    return mapContextoZona(result.rows[0]);
  }

  async findByReferencia(executor, { tipo, origen, referenciaExterna }) {
    const client = executor || this.pool;
    const result = await client.query(
      `SELECT * FROM contexto_zona
       WHERE tipo = $1 AND origen = $2 AND referencia_externa = $3`,
      [tipo, origen, referenciaExterna]
    );
    return mapContextoZona(result.rows[0]);
  }
}

module.exports = { ContextoZonaRepository, mapContextoZona };
