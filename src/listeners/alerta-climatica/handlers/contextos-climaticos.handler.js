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

// Alta de un contexto de zona por cada zona de una alerta climática
// confirmada (un barrio o un punto). Corre en la transacción del
// OutcomeFactory. Si la alerta ya se finalizó (la baja llegó antes), no da de
// alta nada.
//
// Cada zona puede traer su radio (el que cubre su barrio); si no, vale el
// `radioMetros` del payload (el del nivel). Una zona por barrio guarda
// `barrios = [su barrio]`: con eso linkZoneContexts exige que la emergencia
// sea de ese barrio. Una zona por punto guarda `barrios = null` y vincula solo
// por distancia.
//
// Después de cada alta que aplica, vincula también las emergencias que ya
// estaban abiertas en esa zona (linkOpenEmergenciesToZoneContext), en la misma
// transacción: así suben las que se crearon antes de que llegara la alerta.
// Una reentrega no duplica: el dedup por eventId la frena y el vínculo tiene
// ON CONFLICT DO NOTHING.
function createRegistrarContextosClimaticosHandler({ contextoZonaRepository, emergencyRepository }) {
  if (!contextoZonaRepository) {
    throw new Error('createRegistrarContextosClimaticosHandler requiere contextoZonaRepository');
  }
  if (!emergencyRepository) {
    throw new Error('createRegistrarContextosClimaticosHandler requiere emergencyRepository');
  }

  return async function registrarContextosClimaticos(client, payload) {
    assertReferencia(payload, REGISTRAR_CONTEXTOS_CLIMATICOS);
    const {
      origen, alertaId, ubicaciones, radioMetros, vigenteDesde, vigenteHasta,
      descripcion = null, causationId = null, sourceUpdatedAt,
      nivel = null, fenomeno = null,
    } = payload;
    if (!Array.isArray(ubicaciones) || ubicaciones.length === 0) {
      throw new ValidationError('RegistrarContextosClimaticos requiere al menos una ubicación');
    }
    const radioValido = (metros) => Number.isFinite(metros) && metros > 0;
    const radioDe = (ubicacion) => (radioValido(ubicacion?.radioMetros) ? ubicacion.radioMetros : radioMetros);
    if (!ubicaciones.every((ubicacion) => radioValido(radioDe(ubicacion))) || !vigenteDesde || !vigenteHasta) {
      throw new ValidationError('RegistrarContextosClimaticos requiere radioMetros, vigenteDesde y vigenteHasta');
    }

    const grupo = grupoDeLaAlerta(alertaId, origen);
    await contextoZonaRepository.bloquearGrupo(client, grupo);
    if (await contextoZonaRepository.grupoDadoDeBaja(client, grupo)) {
      secureLog('info', 'Alerta climática ya finalizada: no se registran contextos', { alertaId });
      return { applied: 0, finalizada: true };
    }

    let applied = 0;
    let abiertasVinculadas = 0;
    for (const ubicacion of ubicaciones) {
      const { indice, latitud, longitud, barrio = null } = ubicacion;
      if (!Number.isInteger(indice) || indice < 0 || !Number.isFinite(latitud) || !Number.isFinite(longitud)) {
        throw new ValidationError('RegistrarContextosClimaticos requiere índice, latitud y longitud por ubicación');
      }
      const contexto = await contextoZonaRepository.upsert(client, {
        tipo: TIPO,
        origen,
        referenciaExterna: referenciaDeUbicacion(alertaId, indice),
        latitud,
        longitud,
        radioMetros: radioDe(ubicacion),
        vigenteDesde,
        vigenteHasta,
        descripcion,
        causationId,
        sourceUpdatedAt,
        // Nivel y fenómeno, solo para mostrar la alerta (banner).
        nivelCriticidad: nivel,
        fenomeno,
        // Zona por barrio: el vínculo exige que la emergencia sea de este
        // barrio (y el banner lo muestra). Zona por punto: null.
        barrios: typeof barrio === 'string' && barrio ? [barrio] : null,
      });
      if (contexto) {
        applied += 1;
        const alcanzadas = await emergencyRepository.linkOpenEmergenciesToZoneContext(client, contexto);
        abiertasVinculadas += alcanzadas.length;
      }
    }

    secureLog('info', 'Contextos de alerta climática registrados', {
      alertaId,
      ubicaciones: ubicaciones.length,
      porBarrio: ubicaciones.filter((u) => u.barrio).length,
      applied,
      abiertasVinculadas,
    });
    return { applied, abiertasVinculadas, finalizada: false };
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
