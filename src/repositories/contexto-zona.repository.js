// Contextos de zona (ADR "Elevar temporalmente la prioridad con contextos de
// zona", migración V28). Un contexto vigente sube un nivel la prioridad de
// despacho de las emergencias creadas a no más de radio_metros de su punto
// (V31); el vínculo y el cálculo viven en emergency.repository.js, acá solo
// se dan de alta y de baja, y se listan los activos para el banner del
// tablero. nivel_criticidad, fenomeno y barrios (V33) los llena solo la
// alerta climática, para mostrarla.
//
// Orden de llegada (Kafka reentrega y desordena):
// - Un alta más vieja que lo guardado no pisa nada.
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
    nivelCriticidad: row.nivel_criticidad ?? null,
    fenomeno: row.fenomeno ?? null,
    barrios: row.barrios ?? null,
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
  // - nivelCriticidad, fenomeno, barrios: los manda la alerta climática; un
  //   evento comunitario no los manda y quedan NULL.
  async upsert(executor, {
    tipo, latitud, longitud, radioMetros, vigenteDesde, vigenteHasta, origen, referenciaExterna,
    descripcion = null, causationId = null, sourceUpdatedAt,
    suspendido = false, ventanaPorDefecto = false,
    nivelCriticidad = null, fenomeno = null, barrios = null,
  }) {
    const client = executor || this.pool;
    const result = await client.query(
      `INSERT INTO contexto_zona
         (tipo, latitud, longitud, radio_metros, vigente_desde, vigente_hasta, origen, referencia_externa,
          descripcion, causation_id, source_updated_at, suspendido_en,
          nivel_criticidad, fenomeno, barrios)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12::boolean THEN now() END,
               $14, $15, $16::text[])
       ON CONFLICT (tipo, origen, referencia_externa) DO UPDATE
         SET latitud = EXCLUDED.latitud,
             longitud = EXCLUDED.longitud,
             radio_metros = EXCLUDED.radio_metros,
             nivel_criticidad = EXCLUDED.nivel_criticidad,
             fenomeno = EXCLUDED.fenomeno,
             barrios = EXCLUDED.barrios,
             vigente_desde = CASE WHEN $13::boolean THEN contexto_zona.vigente_desde ELSE EXCLUDED.vigente_desde END,
             vigente_hasta = CASE WHEN $13::boolean THEN contexto_zona.vigente_hasta ELSE EXCLUDED.vigente_hasta END,
             suspendido_en = CASE WHEN $12::boolean THEN COALESCE(contexto_zona.suspendido_en, now()) END,
             descripcion = EXCLUDED.descripcion,
             causation_id = EXCLUDED.causation_id,
             source_updated_at = EXCLUDED.source_updated_at,
             updated_at = now()
         WHERE contexto_zona.dado_de_baja_en IS NULL
           AND contexto_zona.source_updated_at <= EXCLUDED.source_updated_at
       RETURNING *`,
      [tipo, latitud, longitud, radioMetros, vigenteDesde, vigenteHasta, origen, referenciaExterna,
        descripcion, causationId, sourceUpdatedAt, Boolean(suspendido), Boolean(ventanaPorDefecto),
        nivelCriticidad, fenomeno, barrios]
    );
    return mapContextoZona(result.rows[0]);
  }

  // Contextos activos o por empezar, para el banner del tablero: no dados de
  // baja, no suspendidos y sin vencer. Incluye los que todavía no empezaron
  // (vigente_desde en el futuro) para que el banner diga "desde las 18:00";
  // enCurso dice si ya empezó, con now() de la base, igual que el vínculo y
  // la suba. Sin tipo, trae todos.
  async findActivos(executor, { tipo = null } = {}) {
    const client = executor || this.pool;
    const result = await client.query(
      `SELECT *, (vigente_desde <= now()) AS en_curso
       FROM contexto_zona
       WHERE dado_de_baja_en IS NULL
         AND suspendido_en IS NULL
         AND vigente_hasta > now()
         AND ($1::text IS NULL OR tipo = $1::text)
       ORDER BY vigente_desde ASC, referencia_externa ASC`,
      [tipo]
    );
    return result.rows.map((row) => ({ ...mapContextoZona(row), enCurso: row.en_curso === true }));
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

  // Grupo de contextos de un mismo objeto externo con varios puntos (una
  // alerta climática): cada punto es `<referenciaBase>#<n>` y la fila
  // `<referenciaBase>` sola es la marca de baja del grupo, que deja ignorar
  // un alta que llega después de la baja (igual que darDeBaja con un
  // contexto suelto).

  // Serializa alta y baja del mismo grupo dentro de la transacción del
  // caller: los dos eventos vienen por tópicos distintos y pueden procesarse
  // a la vez. El lock se suelta con el COMMIT/ROLLBACK.
  async bloquearGrupo(executor, { tipo, origen, referenciaBase }) {
    await executor.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`contexto_zona:${tipo}:${origen}:${referenciaBase}`]
    );
  }

  async grupoDadoDeBaja(executor, { tipo, origen, referenciaBase }) {
    const client = executor || this.pool;
    const result = await client.query(
      `SELECT 1 FROM contexto_zona
       WHERE tipo = $1 AND origen = $2 AND referencia_externa = $3
         AND dado_de_baja_en IS NOT NULL`,
      [tipo, origen, referenciaBase]
    );
    return result.rowCount > 0;
  }

  // Baja lógica del grupo: deja la marca y da de baja los puntos que sigan
  // en curso. Devuelve cuántos puntos dio de baja esta llamada.
  async darDeBajaGrupo(executor, {
    tipo, origen, referenciaBase, causationId = null, sourceUpdatedAt,
  }) {
    const client = executor || this.pool;
    await this.darDeBaja(client, {
      tipo, origen, referenciaExterna: referenciaBase, causationId, sourceUpdatedAt,
    });
    const result = await client.query(
      `UPDATE contexto_zona
         SET dado_de_baja_en = now(),
             source_updated_at = GREATEST(source_updated_at, $4),
             updated_at = now()
       WHERE tipo = $1 AND origen = $2
         AND left(referencia_externa, length($3) + 1) = $3 || '#'
         AND dado_de_baja_en IS NULL`,
      [tipo, origen, referenciaBase, sourceUpdatedAt]
    );
    return result.rowCount;
  }
}

module.exports = { ContextoZonaRepository, mapContextoZona };
