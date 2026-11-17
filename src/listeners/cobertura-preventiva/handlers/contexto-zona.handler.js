const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');

const REGISTRAR_CONTEXTO_ZONA = 'RegistrarContextoZona';
const DAR_DE_BAJA_CONTEXTO_ZONA = 'DarDeBajaContextoZona';

// Alta o actualización del contexto de zona de un objeto externo: un evento
// comunitario (zona por punto + radio) o una alerta climática (zona por
// barrios), los dos de Espacios. Corre en la transacción del OutcomeFactory.
// Que la escritura no aplique (llegó vieja, o el contexto ya está dado de
// baja) es un resultado normal: se loguea y el evento queda procesado.
function tieneRadio({ latitud, longitud, radioMetros }) {
  return Number.isFinite(latitud) && Number.isFinite(longitud) && radioMetros > 0;
}

function tieneBarrios({ barrios }) {
  return Array.isArray(barrios) && barrios.length > 0
    && barrios.every((barrio) => typeof barrio === 'string' && barrio.trim());
}

function createRegistrarContextoZonaHandler({ contextoZonaRepository }) {
  if (!contextoZonaRepository) throw new Error('createRegistrarContextoZonaHandler requiere contextoZonaRepository');

  return async function registrarContextoZona(client, payload) {
    const {
      tipo, origen, referenciaExterna, radioMetros, barrios, vigenteDesde, vigenteHasta,
    } = payload || {};
    if (!tipo || !origen || !referenciaExterna) {
      throw new ValidationError('RegistrarContextoZona requiere tipo, origen y referenciaExterna');
    }
    if (!tieneRadio(payload) && !tieneBarrios(payload)) {
      throw new ValidationError(
        'RegistrarContextoZona requiere una zona: latitud, longitud y radioMetros, o al menos un barrio'
      );
    }
    if (!vigenteDesde || !vigenteHasta) {
      throw new ValidationError('RegistrarContextoZona requiere vigenteDesde y vigenteHasta');
    }

    const contexto = await contextoZonaRepository.upsert(client, payload);
    secureLog('info', contexto ? 'Contexto de zona registrado' : 'Contexto de zona no registrado: llegó viejo o ya está dado de baja', {
      tipo,
      referenciaExterna,
      radioMetros,
      barrios: Array.isArray(barrios) ? barrios.length : 0,
    });
    return { applied: Boolean(contexto), contextoId: contexto ? contexto.id : null };
  };
}

function createDarDeBajaContextoZonaHandler({ contextoZonaRepository }) {
  if (!contextoZonaRepository) throw new Error('createDarDeBajaContextoZonaHandler requiere contextoZonaRepository');

  return async function darDeBajaContextoZona(client, payload) {
    const { tipo, origen, referenciaExterna } = payload || {};
    if (!tipo || !origen || !referenciaExterna) {
      throw new ValidationError('DarDeBajaContextoZona requiere tipo, origen y referenciaExterna');
    }

    const contexto = await contextoZonaRepository.darDeBaja(client, payload);
    secureLog('info', contexto ? 'Contexto de zona dado de baja' : 'Contexto de zona ya estaba dado de baja', {
      tipo,
      referenciaExterna,
    });
    return { applied: Boolean(contexto), contextoId: contexto ? contexto.id : null };
  };
}

module.exports = {
  REGISTRAR_CONTEXTO_ZONA,
  DAR_DE_BAJA_CONTEXTO_ZONA,
  createRegistrarContextoZonaHandler,
  createDarDeBajaContextoZonaHandler,
};
