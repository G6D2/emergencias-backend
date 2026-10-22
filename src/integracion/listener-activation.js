const { ListenerActivationRepository } = require('../repositories/listener-activation.repository');
const { secureLog } = require('../security/secure-log');

// Issue #71 (ADR #25): primera activacion del listener de integracion EDA.
//
// Antes de arrancar los consumers, se descarta cualquier emergencia que haya
// nacido de un evento externo (source=EXTERNAL) y haya quedado en PENDING
// previo al momento en que el listener se activo por primera vez. Esas
// emergencias no van a recibir nunca un EventoCancelado que las libere, ni
// nadie va a procesarlas: no hay nada que esperar por ellas.
//
// Toda la operacion ocurre dentro de una unica transaccion:
//  1. INSERT en listener_activation (ON CONFLICT DO NOTHING como candado).
//  2. Si inserto: UPDATE emergencies status='DISCARDED' donde corresponde.
//  3. UPDATE listener_activation.discarded_count con la cantidad.
//  4. COMMIT.
//
// Si otro pod gano el candado (rowCount=0 en el INSERT), ROLLBACK y leer
// la fila existente para devolver el estado consistente al llamador. En
// corridas posteriores (reinicios) devuelve directo lo persistido.
async function activateAndDiscardStalePending({ pool, repo }) {
  const activationRepo = repo || new ListenerActivationRepository(pool);

  // Fast-path sin transaccion: si ya hay fila, no hay nada que hacer.
  const existing = await activationRepo.get();
  if (existing) {
    return {
      firstActivation: false,
      firstActivatedAt: existing.firstActivatedAt,
      discardedCount: existing.discardedCount,
      discardedIds: [],
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await activationRepo.tryInsertFirstActivation(client);
    if (!inserted) {
      // Otro pod activo mientras tanto. ROLLBACK y leer el valor consolidado.
      await client.query('ROLLBACK');
      const other = await activationRepo.get();
      return {
        firstActivation: false,
        firstActivatedAt: other ? other.firstActivatedAt : null,
        discardedCount: other ? other.discardedCount : 0,
        discardedIds: [],
      };
    }

    const firstActivatedAt = inserted.firstActivatedAt;

    const discardResult = await client.query(
      `UPDATE emergencies
       SET status = 'DISCARDED', updated_at = now()
       WHERE source = 'EXTERNAL'
         AND status = 'PENDING'
         AND created_at < $1
       RETURNING id`,
      [firstActivatedAt]
    );

    const discardedIds = discardResult.rows.map((row) => row.id);
    const discardedCount = discardedIds.length;

    await activationRepo.setDiscardedCount(client, discardedCount);
    await client.query('COMMIT');

    secureLog('info', 'Primera activacion del listener EDA — PENDING externas previas descartadas', {
      firstActivatedAt,
      discardedCount,
    });

    return {
      firstActivation: true,
      firstActivatedAt,
      discardedCount,
      discardedIds,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { activateAndDiscardStalePending };
