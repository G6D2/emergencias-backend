const { randomUUID } = require('crypto');
const { secureLog } = require('../../security/secure-log');

// Crea una emergencia PENDIENTE que representa cobertura preventiva
// pedida por un EventoComunitarioPublicado de Espacios Publicos.
//
// Diseno:
// - Corre dentro de la transaccion del listener (recibe el `client` por ctx).
//   Si el handler hace ROLLBACK, el INSERT se revierte. No se abre otra tx.
// - correlation_id = causationEventId (eventId del Publicado): LiberarCoberturaPreventiva
//   lo usa como clave para encontrar esta emergencia si llega EventoCancelado.
// - Si lat/lng vienen null (espacios cargados antes de que existieran coordenadas,
//   acordado con Luciano), se persiste la emergencia igual pero con
//   requires_manual_validation=true para que el dispatcher la revise.
// - severity = 'baja' por default: cobertura preventiva no es urgente;
//   el motor de incidentes puede elevarla si corresponde.
class ProgramarCoberturaPreventivaCommand {
  constructor({ nombre, latitud, longitud, capacidad, causationEventId, locationCrypto, userIdForExternal = 'eda-bus' }) {
    if (!causationEventId) {
      throw new Error('ProgramarCoberturaPreventiva requiere causationEventId');
    }
    if (!locationCrypto) {
      throw new Error('ProgramarCoberturaPreventiva requiere locationCrypto');
    }
    this.nombre = nombre || 'Evento comunitario';
    this.latitud = typeof latitud === 'number' ? latitud : null;
    this.longitud = typeof longitud === 'number' ? longitud : null;
    this.capacidad = Number.isFinite(capacidad) ? capacidad : null;
    this.causationEventId = causationEventId;
    this.locationCrypto = locationCrypto;
    this.userIdForExternal = userIdForExternal;
  }

  requiresManualValidation() {
    return this.latitud === null || this.longitud === null;
  }

  async execute(ctx) {
    const { client } = ctx;
    if (!client) throw new Error('ProgramarCoberturaPreventiva.execute requiere ctx.client');

    const requiresManual = this.requiresManualValidation();
    const description = this.capacidad != null
      ? `Cobertura preventiva — ${this.nombre} (${this.capacidad} asistentes esperados)`
      : `Cobertura preventiva — ${this.nombre}`;

    // Si lat/lng faltan, no se cifra ubicacion (queda null como las filas
    // legacy de V3 que mantenian location_encrypted NULL).
    const locationEncrypted = requiresManual
      ? null
      : this.locationCrypto.encryptLocation({
        latitude: this.latitud,
        longitude: this.longitud,
        address: this.nombre,
      });

    const emergencyId = randomUUID();
    await client.query(
      `INSERT INTO emergencies (
         id, correlation_id, user_id, latitude, longitude, location_encrypted,
         description, severity, emergency_type, status, source, requires_manual_validation
       )
       VALUES ($1, $2, $3, NULL, NULL, $4, $5, 'baja', 'DISTURBIO_EVENTO_MASIVO', 'PENDING', 'EXTERNAL', $6)`,
      [
        emergencyId,
        this.causationEventId,
        this.userIdForExternal,
        locationEncrypted,
        description,
        requiresManual,
      ]
    );

    secureLog('info', 'Cobertura preventiva programada', {
      emergencyId,
      causationEventId: this.causationEventId,
      requiresManual,
      capacidad: this.capacidad,
    });

    return { emergencyId, requiresManual };
  }
}

module.exports = { ProgramarCoberturaPreventivaCommand };
