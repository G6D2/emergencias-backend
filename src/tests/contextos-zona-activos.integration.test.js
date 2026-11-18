// Banner de alertas climáticas de punta a punta: una CriticidadClimaticaConfirmada
// pasa por el listener del ADR #39 (contextos por punto con radio por nivel) y
// GET /api/contextos-zona/activos la devuelve como una sola entrada, con nivel,
// fenómeno y barrios (columnas de V33). También prueba la migración: columnas,
// CHECK del nivel y el backfill de los contextos que ya existían.
//
// Kafka no corre: se llama a EventListener.onMessage() con el mensaje
// serializado. Postgres y la app HTTP son reales.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const request = require('supertest');
const { getPool } = require('../db/pool');
const { createApp } = require('../app');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../repositories/eventos-procesados.repository');
const { ContextoZonaRepository } = require('../repositories/contexto-zona.repository');
const { OutcomeFactory } = require('../listeners/outcome-factory');
const {
  CriticidadClimaticaConfirmadaListener,
  CriticidadClimaticaFinalizadaListener,
} = require('../listeners/alerta-climatica');
const {
  CREAR_EMERGENCIA_CLIMATICA,
  CANCELAR_EMERGENCIA_CLIMATICA,
  createCrearEmergenciaClimaticaHandler,
  createCancelarEmergenciaClimaticaHandler,
} = require('../listeners/alerta-climatica/handlers/emergencia-climatica.handler');
const {
  REGISTRAR_CONTEXTOS_CLIMATICOS,
  DAR_DE_BAJA_CONTEXTOS_CLIMATICOS,
  createRegistrarContextosClimaticosHandler,
  createDarDeBajaContextosClimaticosHandler,
} = require('../listeners/alerta-climatica/handlers/contextos-climaticos.handler');
const { createLocationCrypto } = require('../security/location-crypto');
const { createLocalJwtAuth } = require('./helpers/local-jwt');

const ROUTE = '/api/contextos-zona/activos';
const CREATED_TOPIC = 'test.banner.emergencias.creada';
const UPDATED_TOPIC = 'test.banner.emergencias.actualizada';
const MIGRATION = path.join(__dirname, '..', '..', 'db', 'migrations', 'V33__contexto_zona_datos_alerta_climatica.sql');
const HORA = 60 * 60 * 1000;
const KAFKA_APAGADO = { isEnabled: () => false, publishEvent: async () => false, checkHealth: async () => false };

let pool;
let app;
let bearers;
let confirmada;
let finalizada;
const alertaIds = [];
const eventIds = [];

function fakeKafka() {
  return { consumer: jest.fn() };
}

function buildMessage(eventObject) {
  return { value: Buffer.from(JSON.stringify(eventObject)) };
}

function confirmacion(overrides = {}) {
  const alertaId = overrides.alertaId || randomUUID();
  const eventId = randomUUID();
  alertaIds.push(alertaId);
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'com.citypass.espacios.CriticidadClimaticaConfirmada', source: 'grupo7' },
    data: {
      alertaId,
      nivelCriticidad: 'ALTA',
      fenomeno: 'TORMENTA_FUERTE',
      ubicaciones: [
        { latitud: -34.6037, longitud: -58.3816 },
        { latitud: -34.5631, longitud: -58.4584 },
      ],
      barrios: ['SAN NICOLAS', 'BELGRANO'],
      vigenciaDesde: Date.now() - HORA,
      vigenciaHasta: Date.now() + 2 * HORA,
      actorSub: 'admin-1',
      ...overrides,
    },
  };
}

function finalizacion(alertaId) {
  const eventId = randomUUID();
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'com.citypass.espacios.CriticidadClimaticaFinalizada', source: 'grupo7' },
    data: { alertaId, finalizadaEn: Date.now(), actorSub: 'admin-1' },
  };
}

// Solo las alertas de este archivo: otros tests pueden dejar las suyas.
async function activas(identidad = 'dispatcher') {
  const res = await request(app).get(ROUTE).set('Authorization', bearers[identidad]);
  if (res.status !== 200) return res;
  return { ...res, alertas: res.body.data.filter((a) => alertaIds.includes(a.alertaId)) };
}

beforeAll(async () => {
  pool = getPool();
  const emergencyRepository = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
  const contextoZonaRepository = new ContextoZonaRepository(pool);

  const factory = new OutcomeFactory(pool, { dedupRepo: new EventosProcesadosRepository(pool) });
  factory.register(
    CREAR_EMERGENCIA_CLIMATICA,
    createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository, topic: CREATED_TOPIC })
  );
  factory.register(
    CANCELAR_EMERGENCIA_CLIMATICA,
    createCancelarEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository, topic: UPDATED_TOPIC })
  );
  factory.register(REGISTRAR_CONTEXTOS_CLIMATICOS, createRegistrarContextosClimaticosHandler({ contextoZonaRepository, emergencyRepository }));
  factory.register(DAR_DE_BAJA_CONTEXTOS_CLIMATICOS, createDarDeBajaContextosClimaticosHandler({ contextoZonaRepository }));
  confirmada = new CriticidadClimaticaConfirmadaListener(fakeKafka(), { factory, topic: 'test.banner.confirmada' });
  finalizada = new CriticidadClimaticaFinalizadaListener(fakeKafka(), { factory, topic: 'test.banner.finalizada' });

  const auth = await createLocalJwtAuth();
  app = createApp(KAFKA_APAGADO, emergencyRepository, { authenticate: auth.authenticate, contextoZonaRepository });
  bearers = {
    dispatcher: await auth.bearerFor({ sub: 'disp-banner-int', groups: ['dispatcher'] }),
    citizen: await auth.bearerFor({ sub: 'cit-banner-int', groups: ['citizen'] }),
  };
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM contexto_zona WHERE tipo = 'ALERTA_CLIMATICA'
       AND split_part(referencia_externa, '#', 1) = ANY($1::text[])`,
    [alertaIds]
  );
  await pool.query('DELETE FROM eventos_procesados WHERE event_id = ANY($1::uuid[])', [eventIds]);
  await pool.query(
    "DELETE FROM emergencies WHERE causa_tipo = 'EVENTO_CLIMATICO' AND causa_id = ANY($1::text[])",
    [alertaIds]
  );
  await pool.query('DELETE FROM outbox_events WHERE topic IN ($1, $2)', [CREATED_TOPIC, UPDATED_TOPIC]);
  await pool.end();
});

describe('V33: datos de la alerta en contexto_zona', () => {
  it('agrega nivel_criticidad, fenomeno y barrios nullable', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'contexto_zona' AND column_name IN ('nivel_criticidad', 'fenomeno', 'barrios')
       ORDER BY column_name`
    );
    expect(rows).toEqual([
      { column_name: 'barrios', data_type: 'ARRAY', is_nullable: 'YES' },
      { column_name: 'fenomeno', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'nivel_criticidad', data_type: 'text', is_nullable: 'YES' },
    ]);
  });

  it('el CHECK rechaza un nivel fuera del catálogo de Espacios', async () => {
    const alertaId = randomUUID();
    alertaIds.push(alertaId);
    await expect(pool.query(
      `INSERT INTO contexto_zona
         (tipo, origen, referencia_externa, latitud, longitud, radio_metros, vigente_desde, vigente_hasta,
          source_updated_at, nivel_criticidad)
       VALUES ('ALERTA_CLIMATICA', 'espacios', $1, -34.6, -58.4, 500, now(), now() + interval '1 hour', now(), 'ROJA')`,
      [`${alertaId}#0`]
    )).rejects.toMatchObject({ constraint: 'contexto_zona_nivel_criticidad_check' });
  });

  it('el backfill saca nivel y fenómeno de la descripción de los contextos que ya existían', async () => {
    const conFenomeno = randomUUID();
    const sinFenomeno = randomUUID();
    alertaIds.push(conFenomeno, sinFenomeno);
    for (const [alertaId, descripcion] of [
      [conFenomeno, 'Alerta climática CRITICA: ola de frio'],
      [sinFenomeno, 'Alerta climática ALTA: evento climático'],
    ]) {
      await pool.query(
        `INSERT INTO contexto_zona
           (tipo, origen, referencia_externa, latitud, longitud, radio_metros, vigente_desde, vigente_hasta,
            source_updated_at, descripcion)
         VALUES ('ALERTA_CLIMATICA', 'espacios', $1, -34.6, -58.4, 500, now(), now() + interval '1 hour', now(), $2)`,
        [`${alertaId}#0`, descripcion]
      );
    }

    // La parte de datos de la migración (el UPDATE) es idempotente: se corre de nuevo.
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    await pool.query(sql.slice(sql.indexOf('UPDATE contexto_zona')));

    const { rows } = await pool.query(
      `SELECT referencia_externa, nivel_criticidad, fenomeno, barrios FROM contexto_zona
       WHERE referencia_externa = ANY($1::text[]) ORDER BY nivel_criticidad`,
      [[`${conFenomeno}#0`, `${sinFenomeno}#0`]]
    );
    expect(rows).toEqual([
      { referencia_externa: `${sinFenomeno}#0`, nivel_criticidad: 'ALTA', fenomeno: null, barrios: null },
      { referencia_externa: `${conFenomeno}#0`, nivel_criticidad: 'CRITICA', fenomeno: 'OLA_DE_FRIO', barrios: null },
    ]);
  });
});

describe('GET /api/contextos-zona/activos (integration)', () => {
  it('una alerta ALTA confirmada sale como una entrada, con sus dos barrios y los datos para el banner', async () => {
    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));

    const { status, alertas } = await activas();
    expect(status).toBe(200);
    const alerta = alertas.find((a) => a.alertaId === evento.data.alertaId);
    expect(alerta).toEqual({
      alertaId: evento.data.alertaId,
      nivel: 'ALTA',
      fenomeno: 'TORMENTA_FUERTE',
      fenomenoEtiqueta: 'Tormenta fuerte',
      barrios: ['SAN NICOLAS', 'BELGRANO'],
      zona: 'BARRIOS',
      vigenteDesde: new Date(evento.data.vigenciaDesde).toISOString(),
      vigenteHasta: new Date(evento.data.vigenciaHasta).toISOString(),
      enCurso: true,
      puntos: 2,
      // Cada barrio tiene su radio: un solo número no describe la alerta.
      radioMetros: null,
      descripcion: 'Alerta climática ALTA: tormenta fuerte',
    });
  });

  it('una alerta sin barrios sale con zona por punto y el radio del nivel', async () => {
    const evento = confirmacion({ barrios: [] });
    await confirmada.onMessage(buildMessage(evento));

    const { alertas } = await activas();
    expect(alertas.find((a) => a.alertaId === evento.data.alertaId)).toMatchObject({
      barrios: [], zona: 'PUNTOS', puntos: 2, radioMetros: 500,
    });
  });

  it('una CRITICA que todavía no empezó sale primero, con su barrio y enCurso false', async () => {
    const evento = confirmacion({
      nivelCriticidad: 'CRITICA',
      fenomeno: 'GRANIZO',
      ubicaciones: [{ latitud: -34.6066, longitud: -58.4355 }],
      barrios: ['CABALLITO'],
      vigenciaDesde: Date.now() + HORA,
      vigenciaHasta: Date.now() + 3 * HORA,
    });
    await confirmada.onMessage(buildMessage(evento));

    const { alertas } = await activas();
    const indice = alertas.findIndex((a) => a.alertaId === evento.data.alertaId);
    expect(alertas[indice]).toMatchObject({
      nivel: 'CRITICA',
      fenomenoEtiqueta: 'Granizo',
      barrios: ['CABALLITO'],
      zona: 'BARRIOS',
      enCurso: false,
      puntos: 1,
      radioMetros: null,
    });
    const primeraAlta = alertas.findIndex((a) => a.nivel === 'ALTA');
    expect(primeraAlta).toBeGreaterThan(indice);
  });

  it('MEDIA y BAJA no aparecen: no generan contextos', async () => {
    const media = confirmacion({ nivelCriticidad: 'MEDIA' });
    const baja = confirmacion({ nivelCriticidad: 'BAJA' });
    await confirmada.onMessage(buildMessage(media));
    await confirmada.onMessage(buildMessage(baja));

    const { alertas } = await activas();
    expect(alertas.map((a) => a.alertaId)).not.toEqual(expect.arrayContaining([media.data.alertaId]));
    expect(alertas.map((a) => a.alertaId)).not.toEqual(expect.arrayContaining([baja.data.alertaId]));
  });

  it('una alerta vencida no aparece', async () => {
    const evento = confirmacion({ vigenciaDesde: Date.now() - 3 * HORA, vigenciaHasta: Date.now() - HORA });
    await confirmada.onMessage(buildMessage(evento));

    const { alertas } = await activas();
    expect(alertas.find((a) => a.alertaId === evento.data.alertaId)).toBeUndefined();
  });

  it('la finalización la saca del banner', async () => {
    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));
    expect((await activas()).alertas.some((a) => a.alertaId === evento.data.alertaId)).toBe(true);

    await finalizada.onMessage(buildMessage(finalizacion(evento.data.alertaId)));

    expect((await activas()).alertas.some((a) => a.alertaId === evento.data.alertaId)).toBe(false);
  });

  it('un ciudadano no puede verlas (403)', async () => {
    const res = await activas('citizen');
    expect(res.status).toBe(403);
  });
});
