const { BusinessRule } = require('../../../business-rule');
const { resolveBarrio } = require('../../../../domain/barrio');
const { isUuid } = require('../../../../utils/uuid');
const {
  CONTEXTO_TIPO,
  ORIGEN_ESPACIOS,
  primerInstante,
  ventanaDeVigencia,
} = require('../../../../domain/contexto-zona');

const MAX_DESCRIPCION_LENGTH = 200;

// Un evento comunitario de Espacios deja un contexto de zona en su barrio:
// mientras dura, las emergencias de ese barrio suben un nivel de prioridad
// de despacho (ADR "Elevar temporalmente la prioridad con contextos de zona").
//
// No depende de la capacidad (eso es la cobertura preventiva, regla 01).
// Espacios republica el evento cuando cambian los inscriptos: cada mensaje
// actualiza el mismo contexto (uno por eventoId).
//
// - Barrio: por coordenadas; sin coordenadas, el texto `barrio` o `zona` si
//   coincide con el catálogo de CABA. Sin barrio no hay contexto.
// - Ventana: `inicio`–`fin` (o `fechaInicio`–`fechaFin`). Sin inicio arranca
//   al recibirlo; sin fin dura CONTEXTO_ZONA_DURACION_DEFAULT_HORAS.
// - Un evento que llega ya cancelado da de baja el contexto.
class RegistrarContextoZonaRule extends BusinessRule {
  barrio(data) {
    const porUbicacion = resolveBarrio({
      latitude: typeof data.latitud === 'number' ? data.latitud : null,
      longitude: typeof data.longitud === 'number' ? data.longitud : null,
      barrioText: typeof data.barrio === 'string' ? data.barrio : null,
    });
    if (porUbicacion) return porUbicacion;
    return typeof data.zona === 'string' ? resolveBarrio({ barrioText: data.zona }) : null;
  }

  cancelado(data) {
    return data.estado === 'CANCELLED';
  }

  appliesTo(context) {
    const data = context.data || {};
    if (typeof data.eventoId !== 'string' || !data.eventoId) return false;
    return this.cancelado(data) || this.barrio(data) !== null;
  }

  apply(context) {
    const { data = {}, metadata = {} } = context;
    const ahora = new Date();
    const referencia = {
      tipo: CONTEXTO_TIPO.EVENTO_ESPACIO_PUBLICO,
      origen: ORIGEN_ESPACIOS,
      referenciaExterna: data.eventoId,
      causationId: isUuid(metadata.eventId) ? metadata.eventId : null,
      sourceUpdatedAt: primerInstante(
        data.actualizadoEn, data.updatedAt,
        metadata.occurredAt, metadata.timestamp, metadata.receivedAt
      ) || ahora,
    };

    if (this.cancelado(data)) {
      return { type: 'DarDeBajaContextoZona', payload: referencia };
    }

    return {
      type: 'RegistrarContextoZona',
      payload: {
        ...referencia,
        barrio: this.barrio(data),
        ...ventanaDeVigencia({
          inicio: data.inicio ?? data.fechaInicio,
          fin: data.fin ?? data.fechaFin,
          ahora,
        }),
        descripcion: typeof data.titulo === 'string' && data.titulo
          ? data.titulo.slice(0, MAX_DESCRIPCION_LENGTH)
          : null,
      },
    };
  }
}

module.exports = { RegistrarContextoZonaRule };
