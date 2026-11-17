jest.mock('../security/secure-log', () => ({ secureLog: jest.fn() }));

const {
  CONTEXTO_TIPO,
  DURACION_DEFAULT_HORAS,
  RADIO_DEFAULT_METROS,
  duracionDefaultMs,
  radioDefaultMetros,
  puntoDelEvento,
  parseInstante,
  primerInstante,
  ventanaDeVigencia,
} = require('../domain/contexto-zona');
const { dispatchPriority } = require('../domain/severity');
const { ContextoZonaRepository, mapContextoZona } = require('../repositories/contexto-zona.repository');
const {
  createRegistrarContextoZonaHandler,
  createDarDeBajaContextoZonaHandler,
} = require('../listeners/cobertura-preventiva/handlers/contexto-zona.handler');
const { RegistrarContextoZonaRule } = require('../listeners/cobertura-preventiva/evento-comunitario-publicado/rules/02-registrar-contexto-zona.rule');
const { DarDeBajaContextoZonaRule } = require('../listeners/cobertura-preventiva/evento-cancelado/rules/02-dar-de-baja-contexto-zona.rule');

const HORA = 60 * 60 * 1000;
const EVENT_ID = 'a1000000-0000-4000-8000-000000000001';
const ROSEDAL = { latitud: -34.5711, longitud: -58.4167 };

describe('domain/contexto-zona', () => {
  describe('parseInstante', () => {
    it('acepta ISO 8601, Date y epoch en segundos o milisegundos', () => {
      expect(parseInstante('2026-11-20T18:00:00.000Z').toISOString()).toBe('2026-11-20T18:00:00.000Z');
      expect(parseInstante(new Date('2026-11-20T18:00:00Z')).toISOString()).toBe('2026-11-20T18:00:00.000Z');
      expect(parseInstante(1795197600000).toISOString()).toBe('2026-11-20T18:00:00.000Z');
      expect(parseInstante(1795197600).toISOString()).toBe('2026-11-20T18:00:00.000Z');
    });

    it('devuelve null para lo que no es una fecha', () => {
      for (const value of [null, undefined, '', '   ', 'mañana', 0, -5, NaN, new Date('x'), {}, true]) {
        expect(parseInstante(value)).toBeNull();
      }
    });
  });

  it('primerInstante devuelve el primero válido, o null', () => {
    expect(primerInstante(null, 'x', '2026-11-20T18:00:00Z', '2027-01-01T00:00:00Z').toISOString())
      .toBe('2026-11-20T18:00:00.000Z');
    expect(primerInstante(null, undefined)).toBeNull();
  });

  describe('duracionDefaultMs', () => {
    it('usa el default si la variable falta o no es un número positivo', () => {
      for (const value of [undefined, '', 'abc', '0', '-2']) {
        expect(duracionDefaultMs({ CONTEXTO_ZONA_DURACION_DEFAULT_HORAS: value })).toBe(DURACION_DEFAULT_HORAS * HORA);
      }
    });

    it('toma las horas de CONTEXTO_ZONA_DURACION_DEFAULT_HORAS', () => {
      expect(duracionDefaultMs({ CONTEXTO_ZONA_DURACION_DEFAULT_HORAS: '2.5' })).toBe(2.5 * HORA);
    });
  });

  describe('radioDefaultMetros', () => {
    it('usa el default si la variable falta o no es un número positivo', () => {
      for (const value of [undefined, '', 'abc', '0', '-50']) {
        expect(radioDefaultMetros({ CONTEXTO_ZONA_RADIO_DEFAULT_METROS: value })).toBe(RADIO_DEFAULT_METROS);
      }
    });

    it('toma los metros de CONTEXTO_ZONA_RADIO_DEFAULT_METROS, en enteros', () => {
      expect(radioDefaultMetros({ CONTEXTO_ZONA_RADIO_DEFAULT_METROS: '300' })).toBe(300);
      expect(radioDefaultMetros({ CONTEXTO_ZONA_RADIO_DEFAULT_METROS: '750.4' })).toBe(750);
    });
  });

  describe('puntoDelEvento', () => {
    it('devuelve el punto si latitud y longitud son números en rango', () => {
      expect(puntoDelEvento({ ...ROSEDAL, titulo: 'x' })).toEqual(ROSEDAL);
      expect(puntoDelEvento({ latitud: 0, longitud: 0 })).toEqual({ latitud: 0, longitud: 0 });
    });

    it('devuelve null si falta una coordenada, no es número o está fuera de rango', () => {
      for (const data of [
        undefined, {}, { latitud: -34.57 }, { longitud: -58.41 },
        { latitud: '-34.57', longitud: '-58.41' }, { latitud: null, longitud: null },
        { latitud: NaN, longitud: -58.41 }, { latitud: 91, longitud: 0 }, { latitud: 0, longitud: -181 },
      ]) {
        expect(puntoDelEvento(data)).toBeNull();
      }
    });
  });

  describe('ventanaDeVigencia', () => {
    const ahora = new Date('2026-11-20T12:00:00.000Z');
    const env = {};

    it('usa inicio y fin del evento', () => {
      const ventana = ventanaDeVigencia({ inicio: '2026-11-21T18:00:00Z', fin: '2026-11-21T23:00:00Z', ahora, env });
      expect(ventana.vigenteDesde.toISOString()).toBe('2026-11-21T18:00:00.000Z');
      expect(ventana.vigenteHasta.toISOString()).toBe('2026-11-21T23:00:00.000Z');
    });

    it('sin inicio arranca ahora; sin fin dura el default', () => {
      const ventana = ventanaDeVigencia({ ahora, env });
      expect(ventana.vigenteDesde).toBe(ahora);
      expect(ventana.vigenteHasta.getTime()).toBe(ahora.getTime() + DURACION_DEFAULT_HORAS * HORA);
    });

    it('un fin que no es posterior al inicio se reemplaza por el default', () => {
      const ventana = ventanaDeVigencia({ inicio: '2026-11-21T18:00:00Z', fin: '2026-11-21T18:00:00Z', ahora, env });
      expect(ventana.vigenteHasta.toISOString()).toBe('2026-11-22T00:00:00.000Z');
    });

    it('sin argumentos arma una ventana desde ahora', () => {
      const ventana = ventanaDeVigencia();
      expect(ventana.vigenteHasta.getTime()).toBeGreaterThan(ventana.vigenteDesde.getTime());
    });
  });
});

describe('severity.dispatchPriority', () => {
  it('sin contexto de zona devuelve la misma prioridad', () => {
    expect(dispatchPriority('medium', false)).toBe('medium');
  });

  it('con contexto sube un nivel, con tope en critical', () => {
    expect(dispatchPriority('low', true)).toBe('medium');
    expect(dispatchPriority('medium', true)).toBe('high');
    expect(dispatchPriority('high', true)).toBe('critical');
    expect(dispatchPriority('critical', true)).toBe('critical');
  });

  it('una prioridad desconocida no se toca', () => {
    expect(dispatchPriority(null, true)).toBeNull();
    expect(dispatchPriority('urgente', true)).toBe('urgente');
  });
});

describe('RegistrarContextoZonaRule', () => {
  const rule = new RegistrarContextoZonaRule();
  const contexto = (data, metadata = { eventId: EVENT_ID }) => ({ metadata, data });

  it('no aplica sin eventoId o sin coordenadas numéricas', () => {
    expect(rule.appliesTo({ metadata: {} })).toBe(false);
    expect(rule.appliesTo(contexto({ ...ROSEDAL }))).toBe(false);
    expect(rule.appliesTo(contexto({ eventoId: 'ev-1' }))).toBe(false);
    expect(rule.appliesTo(contexto({ eventoId: 'ev-1', latitud: '-34.57', longitud: '-58.41' }))).toBe(false);
  });

  it('el texto de barrio o de zona no alcanza: sin coordenadas no hay contexto', () => {
    expect(rule.appliesTo(contexto({ eventoId: 'ev-1', barrio: 'Palermo', zona: 'Palermo' }))).toBe(false);
  });

  it('aplica con coordenadas, sin importar la capacidad ni el barrio', () => {
    expect(rule.appliesTo(contexto({ eventoId: 'ev-1', capacidad: 10, ...ROSEDAL }))).toBe(true);
    expect(rule.appliesTo(contexto({ eventoId: 'ev-1', latitud: -31.42, longitud: -64.18 }))).toBe(true);
  });

  it('el radio sale de CONTEXTO_ZONA_RADIO_DEFAULT_METROS', () => {
    const original = process.env.CONTEXTO_ZONA_RADIO_DEFAULT_METROS;
    process.env.CONTEXTO_ZONA_RADIO_DEFAULT_METROS = '300';
    try {
      expect(rule.apply(contexto({ eventoId: 'ev-1', ...ROSEDAL })).payload.radioMetros).toBe(300);
    } finally {
      if (original === undefined) delete process.env.CONTEXTO_ZONA_RADIO_DEFAULT_METROS;
      else process.env.CONTEXTO_ZONA_RADIO_DEFAULT_METROS = original;
    }
  });

  it('devuelve RegistrarContextoZona con punto, radio, ventana y trazabilidad', () => {
    const outcome = rule.apply(contexto({
      eventoId: 'ev-1',
      titulo: 'Recital en el Rosedal',
      ...ROSEDAL,
      inicio: '2026-11-21T18:00:00Z',
      fin: '2026-11-21T23:00:00Z',
      actualizadoEn: '2026-11-19T10:00:00Z',
    }));

    expect(outcome.type).toBe('RegistrarContextoZona');
    expect(outcome.payload).toMatchObject({
      tipo: CONTEXTO_TIPO.EVENTO_ESPACIO_PUBLICO,
      origen: 'espacios',
      referenciaExterna: 'ev-1',
      ...ROSEDAL,
      radioMetros: RADIO_DEFAULT_METROS,
      descripcion: 'Recital en el Rosedal',
      causationId: EVENT_ID,
    });
    expect(outcome.payload.vigenteDesde.toISOString()).toBe('2026-11-21T18:00:00.000Z');
    expect(outcome.payload.vigenteHasta.toISOString()).toBe('2026-11-21T23:00:00.000Z');
    expect(outcome.payload.sourceUpdatedAt.toISOString()).toBe('2026-11-19T10:00:00.000Z');
  });

  it('acepta fechaInicio/fechaFin y completa lo que falta', () => {
    const antes = Date.now();
    const outcome = rule.apply({
      metadata: { eventId: 'no-es-uuid' },
      data: { eventoId: 'ev-2', titulo: '', ...ROSEDAL, fechaInicio: '2026-11-21T18:00:00Z', fechaFin: '2026-11-21T20:00:00Z' },
    });

    expect(outcome.payload.vigenteDesde.toISOString()).toBe('2026-11-21T18:00:00.000Z');
    expect(outcome.payload.vigenteHasta.toISOString()).toBe('2026-11-21T20:00:00.000Z');
    expect(outcome.payload.descripcion).toBeNull();
    expect(outcome.payload.causationId).toBeNull();
    expect(outcome.payload.sourceUpdatedAt.getTime()).toBeGreaterThanOrEqual(antes);
  });

  it('sin fechas la ventana arranca al recibir el evento y dura el default', () => {
    const antes = Date.now();
    const { payload } = rule.apply(contexto({ eventoId: 'ev-3', ...ROSEDAL }));
    expect(payload.vigenteDesde.getTime()).toBeGreaterThanOrEqual(antes);
    expect(payload.vigenteHasta.getTime() - payload.vigenteDesde.getTime()).toBe(DURACION_DEFAULT_HORAS * HORA);
  });

  it('marca suspendido solo para un estado de suspensión', () => {
    const con = (estado) => rule.apply(contexto({ eventoId: 'ev-6', ...ROSEDAL, estado })).payload.suspendido;
    expect(con('SUSPENDED')).toBe(true);
    expect(con('suspendido')).toBe(true);
    expect(con('ACTIVE')).toBe(false);
    expect(con('SOLD_OUT')).toBe(false);
    expect(con(undefined)).toBe(false);
  });

  it('avisa si la ventana es un default (el evento no trajo fechas)', () => {
    const sinFechas = rule.apply(contexto({ eventoId: 'ev-7', ...ROSEDAL })).payload;
    const conFin = rule.apply(contexto({ eventoId: 'ev-7', ...ROSEDAL, fin: '2026-11-21T23:00:00Z' })).payload;
    expect(sinFechas.ventanaPorDefecto).toBe(true);
    expect(conFin.ventanaPorDefecto).toBe(false);
  });

  it('reconoce la cancelación en inglés o en castellano', () => {
    for (const estado of ['CANCELLED', 'cancelado', 'CANCELADA']) {
      expect(rule.apply(contexto({ eventoId: 'ev-8', estado })).type).toBe('DarDeBajaContextoZona');
    }
  });

  it('un evento que llega cancelado aplica aunque no tenga ubicación y da de baja', () => {
    const cancelado = contexto({ eventoId: 'ev-4', estado: 'CANCELLED' }, { eventId: EVENT_ID, timestamp: '2026-11-19T10:00:00Z' });
    expect(rule.appliesTo(cancelado)).toBe(true);

    const outcome = rule.apply(cancelado);
    expect(outcome.type).toBe('DarDeBajaContextoZona');
    expect(outcome.payload).toMatchObject({ referenciaExterna: 'ev-4', causationId: EVENT_ID });
    expect(outcome.payload.sourceUpdatedAt.toISOString()).toBe('2026-11-19T10:00:00.000Z');
    expect(outcome.payload).not.toHaveProperty('latitud');
    expect(outcome.payload).not.toHaveProperty('radioMetros');
  });

  it('tolera un contexto sin data ni metadata', () => {
    expect(rule.appliesTo({})).toBe(false);
    expect(rule.apply({ data: { eventoId: 'ev-5', estado: 'CANCELLED' } }).payload.causationId).toBeNull();
  });
});

describe('DarDeBajaContextoZonaRule', () => {
  const rule = new DarDeBajaContextoZonaRule();

  it('no aplica sin eventoId', () => {
    expect(rule.appliesTo({ data: {} })).toBe(false);
    expect(rule.appliesTo({})).toBeFalsy();
    expect(rule.appliesTo({ data: { eventoId: 7 } })).toBe(false);
  });

  it('devuelve DarDeBajaContextoZona con canceladoEn como fecha de origen', () => {
    const context = { metadata: { eventId: EVENT_ID }, data: { eventoId: 'ev-1', canceladoEn: '2026-11-05T12:00:00.000Z' } };
    expect(rule.appliesTo(context)).toBe(true);
    const outcome = rule.apply(context);
    expect(outcome.type).toBe('DarDeBajaContextoZona');
    expect(outcome.payload).toMatchObject({
      tipo: CONTEXTO_TIPO.EVENTO_ESPACIO_PUBLICO,
      origen: 'espacios',
      referenciaExterna: 'ev-1',
      causationId: EVENT_ID,
    });
    expect(outcome.payload.sourceUpdatedAt.toISOString()).toBe('2026-11-05T12:00:00.000Z');
  });

  it('sin fecha ni eventId UUID usa ahora y causationId null', () => {
    const antes = Date.now();
    const { payload } = rule.apply({ data: { eventoId: 'ev-1' } });
    expect(payload.causationId).toBeNull();
    expect(payload.sourceUpdatedAt.getTime()).toBeGreaterThanOrEqual(antes);
  });
});

describe('handlers de contexto de zona', () => {
  const client = { query: jest.fn() };
  const payload = {
    tipo: CONTEXTO_TIPO.EVENTO_ESPACIO_PUBLICO,
    origen: 'espacios',
    referenciaExterna: 'ev-1',
    ...ROSEDAL,
    radioMetros: 500,
    vigenteDesde: new Date('2026-11-21T18:00:00Z'),
    vigenteHasta: new Date('2026-11-21T23:00:00Z'),
  };

  it('las factories exigen el repositorio', () => {
    expect(() => createRegistrarContextoZonaHandler({})).toThrow(/contextoZonaRepository/);
    expect(() => createDarDeBajaContextoZonaHandler({})).toThrow(/contextoZonaRepository/);
  });

  it('RegistrarContextoZona hace el upsert con el client de la transacción', async () => {
    const contextoZonaRepository = { upsert: jest.fn().mockResolvedValue({ id: 'ctx-1' }) };
    const handler = createRegistrarContextoZonaHandler({ contextoZonaRepository });

    await expect(handler(client, payload)).resolves.toEqual({ applied: true, contextoId: 'ctx-1' });
    expect(contextoZonaRepository.upsert).toHaveBeenCalledWith(client, payload);
  });

  it('RegistrarContextoZona no falla si la escritura no aplica', async () => {
    const handler = createRegistrarContextoZonaHandler({ contextoZonaRepository: { upsert: jest.fn().mockResolvedValue(null) } });
    await expect(handler(client, payload)).resolves.toEqual({ applied: false, contextoId: null });
  });

  it('RegistrarContextoZona valida el payload', async () => {
    const handler = createRegistrarContextoZonaHandler({ contextoZonaRepository: { upsert: jest.fn() } });
    await expect(handler(client, undefined)).rejects.toThrow(/tipo, origen y referenciaExterna/);
    await expect(handler(client, { ...payload, latitud: null })).rejects.toThrow(/latitud, longitud y radioMetros/);
    await expect(handler(client, { ...payload, radioMetros: 0 })).rejects.toThrow(/latitud, longitud y radioMetros/);
    await expect(handler(client, { ...payload, vigenteHasta: null })).rejects.toThrow(/vigenteDesde y vigenteHasta/);
  });

  it('DarDeBajaContextoZona da de baja y avisa si ya lo estaba', async () => {
    const contextoZonaRepository = { darDeBaja: jest.fn().mockResolvedValueOnce({ id: 'ctx-1' }).mockResolvedValueOnce(null) };
    const handler = createDarDeBajaContextoZonaHandler({ contextoZonaRepository });

    await expect(handler(client, payload)).resolves.toEqual({ applied: true, contextoId: 'ctx-1' });
    await expect(handler(client, payload)).resolves.toEqual({ applied: false, contextoId: null });
    expect(contextoZonaRepository.darDeBaja).toHaveBeenCalledWith(client, payload);
  });

  it('DarDeBajaContextoZona valida el payload', async () => {
    const handler = createDarDeBajaContextoZonaHandler({ contextoZonaRepository: { darDeBaja: jest.fn() } });
    await expect(handler(client, undefined)).rejects.toThrow(/tipo, origen y referenciaExterna/);
  });
});

describe('ContextoZonaRepository', () => {
  const row = {
    id: 'ctx-1',
    tipo: 'EVENTO_ESPACIO_PUBLICO',
    latitud: ROSEDAL.latitud,
    longitud: ROSEDAL.longitud,
    radio_metros: 500,
    vigente_desde: new Date('2026-11-21T18:00:00Z'),
    vigente_hasta: new Date('2026-11-21T23:00:00Z'),
    origen: 'espacios',
    referencia_externa: 'ev-1',
    descripcion: 'Recital',
    causation_id: EVENT_ID,
    source_updated_at: new Date('2026-11-19T10:00:00Z'),
    dado_de_baja_en: null,
    created_at: new Date('2026-11-19T10:00:01Z'),
    updated_at: new Date('2026-11-19T10:00:01Z'),
  };

  it('mapContextoZona pasa la fila a camelCase y tolera null', () => {
    expect(mapContextoZona(undefined)).toBeNull();
    expect(mapContextoZona(row)).toMatchObject({
      id: 'ctx-1',
      ...ROSEDAL,
      radioMetros: 500,
      referenciaExterna: 'ev-1',
      vigenteHasta: row.vigente_hasta,
      dadoDeBajaEn: null,
    });
  });

  it('upsert no pisa un contexto dado de baja ni uno más nuevo', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const repository = new ContextoZonaRepository(pool);

    const result = await repository.upsert(null, {
      tipo: row.tipo,
      latitud: row.latitud,
      longitud: row.longitud,
      radioMetros: row.radio_metros,
      vigenteDesde: row.vigente_desde,
      vigenteHasta: row.vigente_hasta,
      origen: row.origen,
      referenciaExterna: row.referencia_externa,
      sourceUpdatedAt: row.source_updated_at,
    });

    expect(result.id).toBe('ctx-1');
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(tipo, origen, referencia_externa\) DO UPDATE/);
    expect(sql).toMatch(/contexto_zona\.dado_de_baja_en IS NULL/);
    expect(sql).toMatch(/contexto_zona\.source_updated_at <= EXCLUDED\.source_updated_at/);
    expect(values).toEqual([
      row.tipo, row.latitud, row.longitud, row.radio_metros, row.vigente_desde, row.vigente_hasta, row.origen, row.referencia_externa,
      null, null, row.source_updated_at, false, false,
      // nivelCriticidad, fenomeno, barrios: un evento comunitario no los manda.
      null, null, null,
    ]);
  });

  it('upsert guarda nivel, fenómeno y barrios de una alerta climática', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ ...row, tipo: 'ALERTA_CLIMATICA', nivel_criticidad: 'ALTA', fenomeno: 'GRANIZO', barrios: ['PALERMO'] }] }) };
    const repository = new ContextoZonaRepository(pool);

    const result = await repository.upsert(null, {
      tipo: 'ALERTA_CLIMATICA', nivelCriticidad: 'ALTA', fenomeno: 'GRANIZO', barrios: ['PALERMO'],
    });

    expect(result).toMatchObject({ nivelCriticidad: 'ALTA', fenomeno: 'GRANIZO', barrios: ['PALERMO'] });
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/nivel_criticidad, fenomeno, barrios\)/);
    expect(sql).toMatch(/\$16::text\[\]/);
    expect(sql).toMatch(/barrios = EXCLUDED\.barrios/);
    expect(values.slice(13)).toEqual(['ALTA', 'GRANIZO', ['PALERMO']]);
  });

  it('findActivos trae los no dados de baja, no suspendidos y sin vencer, con enCurso según now()', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ ...row, en_curso: true }, { ...row, id: 'ctx-2', en_curso: false }],
      }),
    };
    const repository = new ContextoZonaRepository(pool);

    const result = await repository.findActivos(null, { tipo: 'ALERTA_CLIMATICA' });

    expect(result.map((c) => [c.id, c.enCurso])).toEqual([['ctx-1', true], ['ctx-2', false]]);
    expect(result[0]).toMatchObject({ nivelCriticidad: null, fenomeno: null, barrios: null });
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/\(vigente_desde <= now\(\)\) AS en_curso/);
    expect(sql).toMatch(/dado_de_baja_en IS NULL/);
    expect(sql).toMatch(/suspendido_en IS NULL/);
    expect(sql).toMatch(/vigente_hasta > now\(\)/);
    expect(values).toEqual(['ALERTA_CLIMATICA']);
  });

  it('findActivos sin tipo trae todos y usa el executor recibido', async () => {
    const pool = { query: jest.fn() };
    const executor = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new ContextoZonaRepository(pool);

    await expect(repository.findActivos(executor)).resolves.toEqual([]);
    expect(executor.query.mock.calls[0][1]).toEqual([null]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('upsert marca la suspensión y conserva la ventana guardada si la del evento es un default', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ ...row, suspendido_en: new Date() }] }) };
    const repository = new ContextoZonaRepository(pool);

    const result = await repository.upsert(null, { tipo: row.tipo, suspendido: true, ventanaPorDefecto: true });

    expect(result.suspendidoEn).toBeInstanceOf(Date);
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/suspendido_en = CASE WHEN \$12::boolean THEN COALESCE\(contexto_zona\.suspendido_en, now\(\)\) END/);
    expect(sql).toMatch(/vigente_hasta = CASE WHEN \$13::boolean THEN contexto_zona\.vigente_hasta ELSE EXCLUDED\.vigente_hasta END/);
    // $12 (suspendido) y $13 (ventanaPorDefecto).
    expect(values.slice(11, 13)).toEqual([true, true]);
  });

  it('upsert devuelve null si la escritura no aplicó y usa el executor recibido', async () => {
    const pool = { query: jest.fn() };
    const executor = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new ContextoZonaRepository(pool);

    await expect(repository.upsert(executor, { tipo: row.tipo })).resolves.toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('darDeBaja marca la baja lógica solo si no estaba dado de baja', async () => {
    const executor = { query: jest.fn().mockResolvedValue({ rows: [{ ...row, dado_de_baja_en: new Date() }] }) };
    const repository = new ContextoZonaRepository({ query: jest.fn() });

    const result = await repository.darDeBaja(executor, {
      tipo: row.tipo, origen: row.origen, referenciaExterna: row.referencia_externa, sourceUpdatedAt: row.source_updated_at,
    });

    expect(result.dadoDeBajaEn).toBeInstanceOf(Date);
    const [sql, values] = executor.query.mock.calls[0];
    expect(sql).toMatch(/SET dado_de_baja_en = now\(\)/);
    expect(sql).toMatch(/WHERE contexto_zona\.dado_de_baja_en IS NULL/);
    expect(values).toEqual([row.tipo, row.origen, row.referencia_externa, null, row.source_updated_at]);
  });

  it('darDeBaja usa el pool si no hay executor', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new ContextoZonaRepository(pool);
    const referencia = { tipo: row.tipo, origen: row.origen, referenciaExterna: row.referencia_externa };

    await expect(repository.darDeBaja(null, referencia)).resolves.toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
