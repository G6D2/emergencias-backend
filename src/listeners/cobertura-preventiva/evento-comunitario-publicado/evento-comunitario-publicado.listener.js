const path = require('path');
const { EventListener } = require('../../event-listener');
const { normalizarEventoEspacios } = require('../evento-espacios');

// Actividad de Espacios Publicos que puede requerir cobertura preventiva.
//
// Topic: EDA_TOPIC_EVENTO_PUBLICADO (com.citypass.espacios.ActividadCreada).
// Espacios publica `ActividadCreada` (actividadId, ubicacion.lat/lng,
// fechaHoraInicio/fechaHoraFinalizacion); el payload se normaliza a los nombres
// que leen las reglas (ver evento-espacios.js). La forma anterior
// (EventoComunitarioPublicado: eventoId, latitud/longitud, inicio/fin) sigue
// aceptándose.
//
// El nombre de la clase se conserva: de él sale el group.id del consumer.
class EventoComunitarioPublicadoListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, { topic: process.env.EDA_TOPIC_EVENTO_PUBLICADO, rulesDir: path.join(__dirname, 'rules'), ...options });
  }

  buildContext(event) {
    const context = super.buildContext(event);
    return { ...context, data: normalizarEventoEspacios(context.data) };
  }
}

module.exports = { EventoComunitarioPublicadoListener };
