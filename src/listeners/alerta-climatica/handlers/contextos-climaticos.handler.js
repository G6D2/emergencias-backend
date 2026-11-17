const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');
const { CONTEXTO_TIPO } = require('../../../domain/contexto-zona');
const { grupoDeLaAlerta, referenciaDeUbicacion } = require('../../../domain/alerta-climatica');

const REGISTRAR_CONTEXTOS_CLIMATICOS = 'RegistrarContextosClimaticos';
const DAR_DE_BAJA_CONTEXTOS_CLIMATICOS = 'DarDeBajaContextosClimaticos';
const TIPO = CONTEXTO_TIPO.ALERTA_CLIMATICA;

function assertReferencia({ origen, alertaId } = {}, type) {
  if (!origen || typeof alertaId !== 'string' || !alertaId) {
    throw new ValidationError(`${type} requiere origen y alertaId`);
  }
}

// Alta de un contexto de zona por cada punto de una alerta climática
// confirmada. Corre en la transacción del OutcomeFactory. Si la alerta ya
// se finalizó (la baja llegó antes), no da de alta nada.
function createRegistrarContextosClimaticosHandler({ contextoZonaRepository }) {
  if (!contextoZonaRepository) {
    throw new Error('createRegistrarContextosClimaticosHandler requiere contextoZonaRepository');
  }

  return async function registrarContextosClimaticos(client, payload) {
    assertReferencia(payload, REGISTRAR_CONTEXTOS_CLIMATICOS);
    const {
      origen, alertaId, ubicaciones, radioMetros, vigenteDesde, vigenteHasta,
      descripcion = null, causationId = null, sourceUpdatedAt,
    } = payload;
    if (!Array.isArray(ubicaciones) || ubicaciones.length === 0) {
      throw new ValidationError('RegistrarContextosClimaticos requiere al menos una ubicación');
    }
    if (!(radioMetros > 0) || !vigenteDesde || !vigenteHasta) {
      throw new ValidationError('RegistrarContextosClimaticos requiere radioMetros, vigenteDesde y vigenteHasta');
    }

    const grupo = grupoDeLaAlerta(alertaId, origen);
    await contextoZonaRepository.bloquearGrupo(client, grupo);
    if (await contextoZonaRepository.grupoDadoDeBaja(client, grupo)) {
      secureLog('info', 'Alerta climática ya finalizada: no se registran contextos', { alertaId });
      return { applied: 0, finalizada: true };
    }

    let applied = 0;
    for (const { indice, latitud, longitud } of ubicaciones) {
      if (!Number.isInteger(indice) || indice < 0 || !Number.isFinite(latitud) || !Number.isFinite(longitud)) {
        throw new ValidationError('RegistrarContextosClimaticos requiere índice, latitud y longitud por ubicación');
      }
      const contexto = await contextoZonaRepository.upsert(client, {
        tipo: TIPO,
        origen,
        referenciaExterna: referenciaDeUbicacion(alertaId, indice),
        latitud,
        longitud,
        radioMetros,
        vigenteDesde,
        vigenteHasta,
        descripcion,
        causationId,
        sourceUpdatedAt,
      });
      if (contexto) applied += 1;
    }

    secureLog('info', 'Contextos de alerta climática registrados', {
      alertaId,
      ubicaciones: ubicaciones.length,
      applied,
      radioMetros,
    });
    return { applied, finalizada: false };
  };
}

// Baja de todos los contextos de la alerta. Si llega antes que la
// confirmación, deja la marca y el alta tardía no crea nada.
function createDarDeBajaContextosClimaticosHandler({ contextoZonaRepository }) {
  if (!contextoZonaRepository) {
    throw new Error('createDarDeBajaContextosClimaticosHandler requiere contextoZonaRepository');
  }

  return async function darDeBajaContextosClimaticos(client, payload) {
    assertReferencia(payload, DAR_DE_BAJA_CONTEXTOS_CLIMATICOS);
    const { origen, alertaId, causationId = null, sourceUpdatedAt } = payload;

    const grupo = grupoDeLaAlerta(alertaId, origen);
    await contextoZonaRepository.bloquearGrupo(client, grupo);
    const dadosDeBaja = await contextoZonaRepository.darDeBajaGrupo(client, {
      ...grupo,
      causationId,
      sourceUpdatedAt,
    });

    secureLog('info', 'Contextos de alerta climática dados de baja', { alertaId, dadosDeBaja });
    return { dadosDeBaja };
  };
}

module.exports = {
  REGISTRAR_CONTEXTOS_CLIMATICOS,
  DAR_DE_BAJA_CONTEXTOS_CLIMATICOS,
  createRegistrarContextosClimaticosHandler,
  createDarDeBajaContextosClimaticosHandler,
};
