// Contextos de zona (ADR "Elevar temporalmente la prioridad con contextos de
// zona", migración V28). Un contexto vigente sube un nivel la prioridad de
// despacho de las emergencias de su barrio; el cálculo vive en la lectura de
// emergencias (emergency.repository.js), acá solo se dan de alta y de baja.
//
// Orden de llegada (Kafka reentrega y desordena):
// - Un alta más vieja que lo guardado no pisa nada.
// - La baja es lógica y definitiva: un alta posterior no revive el contexto.
// - Una baja sin alta previa deja una fila ya dada de baja, así el alta
//   tardía se ignora.
// Una escritura que no aplica es un resultado normal, no un error.

function mapContextoZona(row) {
  if (!row) return null;
  return {
    id: row.id,
    tipo: row.tipo,
    barrio: row.barrio,
    vigenteDesde: row.vigente_desde,
    vigenteHasta: row.vigente_hasta,
    origen: row.origen,
    referenciaExterna: row.referencia_externa,
    descripcion: row.descripcion,
    causationId: row.causation_id,
    sourceUpdatedAt: row.source_updated_at,
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
  async upsert(executor, {
    tipo, barrio, vigenteDesde, vigenteHasta, origen, referenciaExterna,
    descripcion = null, causationId = null, sourceUpdatedAt,
  }) {
    const client = executor || this.pool;
    const result = await client.query(
      `INSERT INTO contexto_zona
         (tipo, barrio, vigente_desde, vigente_hasta, origen, referencia_externa,
          descripcion, causation_id, source_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tipo, origen, referencia_externa) DO UPDATE
         SET barrio = EXCLUDED.barrio,
             vigente_desde = EXCLUDED.vigente_desde,
             vigente_hasta = EXCLUDED.vigente_hasta,
             descripcion = EXCLUDED.descripcion,
             causation_id = EXCLUDED.causation_id,
             source_updated_at = EXCLUDED.source_updated_at,
             updated_at = now()
         WHERE contexto_zona.dado_de_baja_en IS NULL
           AND contexto_zona.source_updated_at <= EXCLUDED.source_updated_at
       RETURNING *`,
      [tipo, barrio, vigenteDesde, vigenteHasta, origen, referenciaExterna,
        descripcion, causationId, sourceUpdatedAt]
    );
    return mapContextoZona(result.rows[0]);
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
