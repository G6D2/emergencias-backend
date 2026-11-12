const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const {
  CONTEXTO_TIPO,
  ORIGEN_ESPACIOS,
  esEstadoCancelado,
  esEstadoSuspendido,
  parseInstante,
  primerInstante,
  puntoDelEvento,
  radioDefaultMetros,
  ventanaDeVigencia,
} = require('../../../../domain/contexto-zona');

const MAX_DESCRIPCION_LENGTH = 200;

// Un evento comunitario de Espacios deja un contexto de zona alrededor de su
// ubicación: mientras dura, las emergencias a no más de `radioMetros` suben
// un nivel de prioridad de despacho (ADR "Elevar temporalmente la prioridad
// con contextos de zona").
//
// No depende de la capacidad (eso es la cobertura preventiva, regla 01).
// Espacios republica el evento cuando cambian los inscriptos: cada mensaje
// actualiza el mismo contexto (uno por eventoId).
//
// - Zona: `latitud` y `longitud` del evento más un radio fijo del backend
//   (CONTEXTO_ZONA_RADIO_DEFAULT_METROS). Sin coordenadas numéricas no hay
//   contexto: el texto `barrio` o `zona` no alcanza para medir distancia.
// - Ventana: `inicio`–`fin` (o `fechaInicio`–`fechaFin`). Sin inicio arranca
//   al recibirlo; sin fin dura CONTEXTO_ZONA_DURACION_DEFAULT_HORAS. Una
//   republicación sin ninguna de las dos fechas conserva la ventana guardada.
// - Un evento suspendido (pausa temporal de Espacios) deja el contexto
//   suspendido: no eleva nada hasta que se republica reanudado.
// - Un evento que llega ya cancelado da de baja el contexto (definitivo).
class RegistrarContextoZonaRule extends BusinessRule {
  cancelado(data) {
    return esEstadoCancelado(data.estado);
  }

  appliesTo(context) {
    const data = context.data || {};
    if (typeof data.eventoId !== 'string' || !data.eventoId) return false;
    return this.cancelado(data) || puntoDelEvento(data) !== null;
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

    const inicio = data.inicio ?? data.fechaInicio;
    const fin = data.fin ?? data.fechaFin;

    return {
      type: 'RegistrarContextoZona',
      payload: {
        ...referencia,
        ...puntoDelEvento(data),
        radioMetros: radioDefaultMetros(),
        ...ventanaDeVigencia({ inicio, fin, ahora }),
        // Sin fechas en el evento la ventana es un default: sirve para el
        // alta, pero no pisa la ventana de un contexto que ya existe.
        ventanaPorDefecto: !parseInstante(inicio) && !parseInstante(fin),
        suspendido: esEstadoSuspendido(data.estado),
        descripcion: typeof data.titulo === 'string' && data.titulo
          ? data.titulo.slice(0, MAX_DESCRIPCION_LENGTH)
          : null,
      },
    };
  }
}

module.exports = { RegistrarContextoZonaRule };
