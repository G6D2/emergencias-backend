const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const { secureLog } = require('../../../../security/secure-log');
const { matchBarrioFromText, resolveBarrioFromPoint } = require('../../../../domain/barrio');
const { CONTEXTO_TIPO, ORIGEN_ESPACIOS, primerInstante } = require('../../../../domain/contexto-zona');
const {
  esFenomenoConocido,
  gravedadDesdeEvento,
  normalizarFenomeno,
  tiposAfectados,
  ventanaAlertaClimatica,
} = require('../../../../domain/alerta-climatica');

const MAX_DESCRIPCION_LENGTH = 200;
const MAX_BARRIOS_EN_LOG = 10;
// Tope de ubicaciones que se resuelven por polígono, contra payloads enormes.
const MAX_UBICACIONES = 50;

// Barrios de las ubicaciones ({ latitud, longitud }) del contrato real de
// Espacios, resueltos con los polígonos del catálogo. Sin duplicados; los
// puntos fuera de CABA (null) se ignoran. Procesa como máximo MAX_UBICACIONES.
function barriosDeUbicaciones(ubicaciones) {
  const lista = Array.isArray(ubicaciones) ? ubicaciones : [];
  const barrios = [];
  for (const ubicacion of lista.slice(0, MAX_UBICACIONES)) {
    const { latitud, longitud } = ubicacion || {};
    if (!Number.isFinite(latitud) || !Number.isFinite(longitud)) continue;
    const barrio = resolveBarrioFromPoint(latitud, longitud);
    if (barrio && !barrios.includes(barrio)) barrios.push(barrio);
  }
  return { barrios, recibidas: lista.length, excedidas: Math.max(0, lista.length - MAX_UBICACIONES) };
}

// Barrios de la alerta llevados al catálogo (domain/barrio.js), sin
// duplicados. Los que no matchean se devuelven aparte para el log. Si de
// `barrios` no queda ninguno válido (Espacios lo manda vacío cuando no pudo
// calcularlo), se derivan de `ubicaciones`.
function barriosDeLaAlerta(data) {
  const recibidos = Array.isArray(data.barrios) ? data.barrios : [];
  const validos = [];
  const desconocidos = [];
  for (const barrio of recibidos) {
    const canonico = matchBarrioFromText(barrio);
    if (!canonico) desconocidos.push(barrio);
    else if (!validos.includes(canonico)) validos.push(canonico);
  }
  if (validos.length > 0) return { validos, desconocidos, ubicaciones: null };

  const ubicaciones = barriosDeUbicaciones(data.ubicaciones);
  return { validos: ubicaciones.barrios, desconocidos, ubicaciones };
}

// Una alerta climática confirmada deja un contexto de zona por alerta
// (referenciaExterna = alertaId) con todos sus barrios. Mientras dura, sube un
// nivel la prioridad de despacho de las emergencias abiertas de esos barrios,
// para los tipos que afecta el fenómeno (ADR "Elevar la prioridad con
// contextos de zona por radio o por barrio").
//
// Acepta dos formatos de `data`: el contrato real de Espacios
// (CriticidadClimaticaConfirmada: nivelCriticidad, vigenciaDesde,
// vigenciaHasta, barrios, ubicaciones) y el del ejemplo anterior (gravedad,
// fechaInicio, fechaFinEstimada, barrios). Si llegan campos de los dos, gana
// el del ejemplo.
//
// - Barrios: los que no están en el catálogo se ignoran con un warn. Si no
//   queda ninguno, se derivan de `ubicaciones` por polígono (hasta 50). Si
//   tampoco, no hay contexto: el ADR no admite contextos de toda la ciudad, y
//   la alerta queda solo en el log.
// - Gravedad: `gravedad`, o `nivelCriticidad` traducida (CRITICA = EXTREMA).
//   LEVE, MEDIA, nula o desconocida crea el contexto (sale en el banner) con
//   tiposEmergencia = [], así que no eleva nada.
// - Fenómeno desconocido: warn y los tipos por defecto.
// - Ventana: fechaInicio (o vigenciaDesde) hasta fechaFinEstimada (o
//   vigenciaHasta) + margen, o el tope si no hay fin. La alerta la cierra el
//   evento de finalización.
// - Una nueva `version` actualiza el mismo contexto. Una versión menor que
//   llega tarde no pisa nada (lo resuelve el repositorio).
//
// Sin efectos en tablas. Los warn van al log.
class RegistrarContextoClimaRule extends BusinessRule {
  appliesTo(context) {
    const data = context.data || {};
    if (!isUuid(data.alertaId)) return false;
    const { validos, ubicaciones } = barriosDeLaAlerta(data);
    if (validos.length > 0) return true;
    secureLog('warn', 'Alerta climática sin barrios reconocidos: no se crea contexto de zona', {
      alertaId: data.alertaId,
      barrios: Array.isArray(data.barrios) ? data.barrios.slice(0, MAX_BARRIOS_EN_LOG) : null,
      ubicaciones: ubicaciones ? ubicaciones.recibidas : 0,
    });
    return false;
  }

  apply(context) {
    const { data = {}, metadata = {} } = context;
    const ahora = new Date();
    const { validos, desconocidos, ubicaciones } = barriosDeLaAlerta(data);
    const fenomeno = normalizarFenomeno(data.fenomeno);
    const gravedad = gravedadDesdeEvento(data);

    if (ubicaciones && ubicaciones.excedidas > 0) {
      secureLog('warn', `Alerta climática con más de ${MAX_UBICACIONES} ubicaciones: se usan las primeras ${MAX_UBICACIONES}`, {
        alertaId: data.alertaId,
        ubicaciones: ubicaciones.recibidas,
      });
    }
    if (desconocidos.length > 0) {
      secureLog('warn', 'Alerta climática con barrios fuera del catálogo: se ignoran', {
        alertaId: data.alertaId,
        barrios: desconocidos.slice(0, MAX_BARRIOS_EN_LOG),
      });
    }
    if (!esFenomenoConocido(fenomeno)) {
      secureLog('warn', 'Alerta climática con fenómeno desconocido: se usan los tipos por defecto', {
        alertaId: data.alertaId,
        fenomeno: data.fenomeno ?? null,
      });
    }
    if (!gravedad) {
      secureLog('warn', 'Alerta climática con gravedad desconocida: no eleva la prioridad', {
        alertaId: data.alertaId,
        gravedad: data.gravedad ?? null,
        nivelCriticidad: data.nivelCriticidad ?? null,
      });
    }

    return {
      type: 'RegistrarContextoZona',
      payload: {
        tipo: CONTEXTO_TIPO.ALERTA_CLIMATICA,
        origen: ORIGEN_ESPACIOS,
        referenciaExterna: data.alertaId,
        barrios: validos,
        tiposEmergencia: tiposAfectados({ fenomeno, gravedad }),
        fenomeno,
        gravedad,
        versionOrigen: Number.isInteger(data.version) && data.version >= 0 ? data.version : null,
        ...ventanaAlertaClimatica({
          fechaInicio: data.fechaInicio ?? data.vigenciaDesde,
          fechaFinEstimada: data.fechaFinEstimada ?? data.vigenciaHasta,
          ahora,
        }),
        // Cada versión trae su propia ventana: siempre pisa la guardada.
        ventanaPorDefecto: false,
        suspendido: false,
        descripcion: typeof data.descripcion === 'string' && data.descripcion
          ? data.descripcion.slice(0, MAX_DESCRIPCION_LENGTH)
          : null,
        causationId: isUuid(metadata.eventId) ? metadata.eventId : null,
        sourceUpdatedAt: primerInstante(metadata.occurredAt, metadata.timestamp, metadata.receivedAt) || ahora,
      },
    };
  }
}

module.exports = { RegistrarContextoClimaRule };
