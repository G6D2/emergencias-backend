# listeners

Listeners de eventos externos (Kafka). Se arrancan desde `src/index.js` con
`KAFKA_CONSUMER_ENABLED=true`.

```
listeners/
  event-listener.js            # clase abstracta: consumer, suscripcion, template method
  business-rule.js             # regla de negocio abstracta
  load-rules.js                # carga automatica de *.rule.js
  outcome-factory.js           # ejecuta los resultados en una transaccion con dedup
  event-decoder.js             # Avro (formato Confluent) o JSON -> { metadata, data }
  error-classifier.js          # errores transitorios vs permanentes
  listener-supervisor.js       # arranque con reintentos y estado para /health
  index.js                     # createListeners(kafka, { factory, decoder }) + PACKAGES
  <caso-de-negocio>/           # un subpaquete por caso de negocio
    index.js                   # exporta `listeners: [ ... ]`
    <evento>/                  # una carpeta por listener
      <evento>.listener.js     # subclase de EventListener
      rules/                   # reglas de este listener, se cargan solas
        <regla>.rule.js        # una regla por archivo
    handlers/                  # handlers del OutcomeFactory de este caso
```

## Flujo de un evento

1. `onMessage` decodifica el mensaje con `event-decoder.js`: el gateway del
   Grupo 1 escribe Avro en formato Confluent (`[0x00][schemaId][avro]`) y el
   schema se resuelve contra `EDA_SCHEMA_REGISTRY_URL`. Lo que no empieza con
   `0x00` se lee como JSON (tests y Kafka local).
2. `handle(event)` es un template method (no se sobreescribe):
   1. `buildContext(event)` arma el contexto `{ metadata, data }`. Se puede
      sobreescribir para normalizar el evento.
   2. Para cada regla de la carpeta `rules/` del listener: si
      `appliesTo(context)` da true, se agrega el resultado de `apply(context)`.
      Aplican todas las que matchean, no solo la primera.
   3. Devuelve los resultados `{ type, payload }`. Las reglas no tienen side
      effects.
3. El `OutcomeFactory` ejecuta los resultados: busca el handler registrado
   para cada `type` (un `type` sin handler falla antes de abrir la
   transaccion), abre una sola transaccion, marca el `metadata.eventId` en
   `eventos_procesados` y corre los handlers con el mismo `client`. Si el
   `eventId` ya estaba (`PROCESSED` o `DISCARDED`), hace ROLLBACK sin efectos
   y el listener deja un log `info` `<Listener> descarto un duplicado` con
   `topic`, `eventId`, `eventType`, `source` y `offset` (sin datos de `data`). Los handlers escriben por los repositorios
   (outbox e historial incluidos), nunca con SQL directo sobre `emergencies`.
   Los handlers se registran en `src/index.js`.

Las altas externas conservan el `correlationId` que llega aunque no sea UUID
(`evento-<id>`, `act-<id>`, `EMG-...`): `src/domain/correlation-id.js` solo
descarta lo que no es un string, está vacío, pasa de 128 caracteres o trae
caracteres de control. En ese caso, o si no viene, la emergencia usa su
propio id.

`reclamo-intervencion` es el caso de la ciclovía obstruida (Reclamos →
Movilidad → Emergencias). `RECLAMO_INTERVENCION_DISPARADOR`
(`reclamo-intervencion/disparador.js`) decide qué evento crea la intervención
`TRANSITO`: `movilidad` (default: solo `EmergenciaSolicitada`), `reclamo`
(solo `ReclamoCreado.v3`, el plan B) o `ambos` (el primero que llegue; el otro
la encuentra creada). Un valor que no es ninguno de los tres frena el
arranque. Los dos listeners usan el mismo handler `CrearIntervencionPorReclamo`
y nunca crean dos por reclamo (`findByCausa` + índice único de V29).
`ReclamoActualizado` con estado final (`RESUELTO`, `RECHAZADO`, `CERRADO`)
cancela la intervención si sigue en `PENDING` o `VALIDATED`, sin importar el
disparador. Secuencia en `docs/diagramas/05-secuencias.md` (f).

`EmergenciaBicicleta` de Movilidad tiene un listener independiente de
`EmergenciaSolicitada`: crea una emergencia médica por `data.emergenciaId`,
deduplica además por la causa única `MOVILIDAD_BICICLETA`, y conserva ese ID
externo como `correlationId`. Los campos personales de `data.usuario` y
`actorSub` no se persisten.

`ReservaCreada` de Espacios (`cobertura-preventiva/reserva-creada`) reusa el
handler `ProgramarCobertura` con `causaTipo = RESERVA`: una reserva de espacio
de 500 personas o más (`UMBRAL_PERSONAS_COBERTURA_RESERVA`) programa una
`PREVENTIVA` por `reservaId`. Es opt-in: sin `EDA_TOPIC_RESERVA_CREADA` el
consumer no se suscribe, porque un topic inexistente frenaría a todos.

`alerta-climatica` sigue el ADR "Responder a las alertas climáticas de
Espacios". `CriticidadClimaticaConfirmada` solo actúa con nivel `ALTA` o
`CRITICA` (`BAJA` y `MEDIA` no generan nada): deja un contexto de zona por
cada punto de `ubicaciones` (referencia `<alertaId>#<n>`) con el radio del
nivel (`CONTEXTO_ZONA_RADIO_CLIMA_CRITICA_METROS`, default 1000;
`CONTEXTO_ZONA_RADIO_CLIMA_ALTA_METROS`, default 500) y una emergencia
`PREVENTIVA` por `alertaId` con causa `EVENTO_CLIMATICO`.
`CriticidadClimaticaFinalizada` da de baja el grupo y cancela la `PREVENTIVA`
sin despachar: deja la fila `<alertaId>` como marca, así una confirmación que
llega tarde no crea contextos ni emergencia. Los cuatro handlers toman el
mismo advisory lock de la transacción por alerta, porque los dos eventos
llegan por tópicos distintos y el consumer procesa particiones en paralelo.
Los dos listeners son opt-in (`EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA` y
`EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA`, sin default), igual que
`ReservaCreada`.

## Errores

`error-classifier.js` decide:

- **Transitorio** (base caida, conexion cortada, registry inalcanzable): el
  error se propaga a kafkajs, que no confirma el offset y reentrega el mensaje.
- **Permanente** (mensaje ilegible, payload invalido, `type` sin handler,
  `metadata.eventId` que no es UUID, constraint): se loguea, queda en
  `eventos_procesados` como `DISCARDED` con el motivo y el offset avanza. Un
  evento roto nunca frena el topico. Un mensaje ilegible (no hay `eventId`) o
  un `eventId` que no es UUID (la columna es uuid) no entran en
  `eventos_procesados`: quedan solo en el log. Para reprocesar un `DISCARDED`,
  ver [Reprocesar un evento `DISCARDED`](#reprocesar-un-evento-discarded).

Se decide solo por codigo (SQLSTATE: 22xxx y 23xxx permanentes; 08xxx, 53xxx,
57xxx, 40001 y 40P01 transitorios; `ECONNRESET` y demas codigos de red
transitorios) o por la marca `transient`/`permanent` que ponen el decoder y el
`OutcomeFactory`. Nunca por el texto del mensaje: puede traer datos del evento.
`pg` tira los cortes de conexion sin SQLSTATE, asi que el `OutcomeFactory` los
marca transitorios: si no consigue conexion, o si ni el `ROLLBACK` anda.

### Reprocesar un evento `DISCARDED`

Un `DISCARDED` no frena el tópico: el offset avanzó y lo que vino después se
procesó. La fila queda en `eventos_procesados` para que una reentrega del mismo
`eventId` no se vuelva a procesar. Es el primo del `FAILED` del outbox
(`npm run outbox:requeue-failed`), pero del lado del consumo: no hay nada que
reencolar en nuestra base, porque el mensaje vive en el broker del Grupo 1.

**1. Encontrarlo.**

```bash
npm run eventos:descartados                      # los 50 más nuevos, no cambia nada
npm run eventos:descartados -- --limit 200
npm run eventos:descartados -- --id <eventId>
```

O directo en SQL:

```sql
-- Los últimos descartes, con el motivo
SELECT event_id, source, event_type, processed_at, discard_reason
FROM eventos_procesados
WHERE status = 'DISCARDED'
ORDER BY processed_at DESC
LIMIT 50;

-- Cuántos por tipo y motivo: un mismo motivo repetido suele ser un bug nuestro
SELECT event_type, left(discard_reason, 80) AS motivo, count(*) AS n, max(processed_at) AS ultimo
FROM eventos_procesados
WHERE status = 'DISCARDED'
GROUP BY 1, 2
ORDER BY ultimo DESC;
```

`discard_reason` es el `message` del error, recortado a 500 caracteres. Puede
traer algún valor del evento (por ejemplo, el texto que no era UUID): no se pega
en issues públicos. El tópico sale de `event_type` (cada listener tiene el suyo,
ver los `EDA_TOPIC_*` de `render.yaml`) o del log `<Listener> descarto el
evento`, que trae `topic` y `eventId`.

**2. Arreglar la causa antes.** Si el motivo es nuestro (`type` sin handler,
constraint, bug en una regla), primero va el fix a producción: si no, el evento
vuelve a quedar `DISCARDED`. Si el payload vino mal, lo corrige el productor.

**3a. Pedir la republicación (preferido).** El productor vuelve a publicar el
evento por el gateway, que genera un `metadata.eventId` nuevo en cada
publicación (ver `docs/diagramas/06-eventos.md`, fila "Entrega"). La fila
`DISCARDED` vieja no lo frena: no se toca la base y la fila queda como
historia. Si la emergencia de esa causa ya existiera, los handlers de alta la
encuentran (`findByCausa` y los índices únicos de causa) y no crean otra.

- Riesgo: depende de otro equipo, y el evento llega tarde. Si ya llegó uno
  posterior de la misma entidad (por ejemplo, la cancelación de ese evento
  comunitario), revisar que el handler lo tolere. La cancelación adelantada
  está cubierta (#88); otros casos, no necesariamente.
- Verificar: un `PROCESSED` nuevo con el mismo `source` y `event_type`, y en el
  log `<Listener> proceso evento` con sus outcomes.

**3b. Releer el mismo mensaje (reset de offset).** Para cuando no se puede
republicar. Es el mismo `eventId`, así que primero se borra su fila de dedup
(si no, la reentrega se descarta como duplicado y queda el log `descarto un
duplicado`):

```bash
npm run eventos:descartados -- --id <eventId> --apply
```

```sql
-- equivalente
DELETE FROM eventos_procesados
WHERE event_id = '<eventId>' AND status = 'DISCARDED'
RETURNING event_id, event_type, discard_reason;
```

**Nunca borrar una `PROCESSED`**: su reentrega aplicaría los efectos dos veces.
El script no lo permite y exige `--id` (no borra en masa).

Después se mueve el offset del grupo, **solo en ese tópico**, a un momento
anterior al mensaje. El grupo tiene que estar vacío: hay que apagar el consumo
mientras tanto (`KAFKA_CONSUMER_ENABLED=false` y redeploy, o suspender el
servicio). Con las herramientas de Kafka (3.4 o más nuevo) y un
`client.properties` con el mismo cliente de servicio que usa el backend
(`EDA_OAUTH_*`):

```properties
security.protocol=SASL_SSL
sasl.mechanism=OAUTHBEARER
sasl.oauthbearer.token.endpoint.url=<EDA_OAUTH_TOKEN_URL>
sasl.login.callback.handler.class=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginCallbackHandler
sasl.jaas.config=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required clientId="<EDA_OAUTH_CLIENT_ID>" clientSecret="<EDA_OAUTH_CLIENT_SECRET>";
```

```bash
# Desde Kafka 3.9.1/4.0 la URL del token tiene que estar permitida
export KAFKA_OPTS="-Dorg.apache.kafka.sasl.oauthbearer.allowed.urls=<EDA_OAUTH_TOKEN_URL>"
B=<KAFKA_BROKER>
G=com.citypass.emergencias.eventos
T=com.citypass.espacios.EventoCancelado     # el tópico del evento

# Estado del grupo: tiene que figurar sin miembros
kafka-consumer-groups.sh --bootstrap-server $B --command-config client.properties --describe --group $G

# Plan, sin cambiar nada; después lo mismo con --execute
kafka-consumer-groups.sh --bootstrap-server $B --command-config client.properties \
  --group $G --topic $T --reset-offsets --to-datetime 2026-11-17T12:00:00.000Z --dry-run

# Si se conoce la partición y el offset exactos
kafka-consumer-groups.sh --bootstrap-server $B --command-config client.properties \
  --group $G --topic $T:0 --reset-offsets --to-offset 1234 --dry-run
```

Para ver partición, offset y timestamp de los mensajes sin volcar el payload,
`kcat` (librdkafka 1.9 o más nuevo) desde un timestamp en milisegundos
(`1794916800000` es 2026-11-17T12:00:00Z):

```bash
kcat -b $B -X security.protocol=SASL_SSL -X sasl.mechanisms=OAUTHBEARER \
  -X sasl.oauthbearer.method=oidc -X sasl.oauthbearer.token.endpoint.url=<EDA_OAUTH_TOKEN_URL> \
  -X sasl.oauthbearer.client.id=<EDA_OAUTH_CLIENT_ID> -X sasl.oauthbearer.client.secret=<EDA_OAUTH_CLIENT_SECRET> \
  -C -t $T -o s@1794916800000 -e -f '%p %o %T\n'
```

Al volver a prender el consumo, verificar que `npm run eventos:descartados -- --id
<eventId>` ya no lo lista y que la fila está `PROCESSED`.

Riesgos del reset:

- **Apaga los diez listeners** mientras dura: hay un solo grupo para todos. Lo
  que llega en ese rato espera en el broker, no se pierde.
- **Rebobina todo el tópico desde esa fecha**, en todas sus particiones (con
  `--to-datetime`). Los `PROCESSED` del medio se descartan por la dedup (log
  `descarto un duplicado`) y los otros `DISCARDED` también, salvo los que fallan
  antes de la dedup (ilegibles, `eventId` que no es UUID, payload que rechaza
  una regla, `type` sin handler), que se vuelven a descartar y a loguear. Nunca `--to-earliest` ni
  `--all-topics`.
- **`EDA_CONSUMER_SINCE`**: un mensaje anterior al piso se saltea sin procesar y
  su offset se commitea igual. Bajar el piso también procesa los eventos viejos
  que nunca entraron (los de prueba): no se baja sin mirar qué hay en el medio.
- **Retención del broker**: si el mensaje ya se borró del tópico, no hay a dónde
  volver. La retención la define el Grupo 1.
- **Permisos**: el broker puede no dejarle a nuestro cliente cambiar los offsets
  del grupo (ACL). En ese caso, se le pide al Grupo 1, que lo administra.
- **Orden**: igual que en 3a, el evento se aplica después de los posteriores de
  la misma entidad.

## Conexion al bus

- `group.id`: `com.citypass.emergencias.eventos` por default, uno solo para
  todos los listeners (`event-consumer.js`). `KAFKA_CONSUMER_GROUP_PREFIX`
  cambia el prefijo, pero tiene que empezar con `com.citypass.emergencias.`:
  el broker solo acepta ese prefijo.
- SASL/OAUTHBEARER con el token client-credentials del Login Federado
  (`EDA_OAUTH_*`, ver `KafkaService`). Sin secreto se conecta sin SASL.
- `KAFKA_SSL=true` en produccion (SASL_SSL).
- Si un listener no arranca (o kafkajs lo da por muerto: `CRASH` sin
  restart), `listener-supervisor.js` lo reintenta a los 5 s, 30 s, 2 min y
  despues cada 2 min. El estado de cada uno (`running`, `retrying`, ultimo
  fetch al broker) sale en `GET /health`.
- Arranque sin offset commiteado (grupo nuevo, o que todavia no proceso
  ningun mensaje): lee el topic desde el principio
  (`EDA_CONSUMER_FROM_BEGINNING`, default `true`). Con `false` arranca en el
  final y pierde lo publicado mientras el servicio dormia (Render free lo
  duerme a los 15 min sin trafico). Con offset commiteado, kafkajs retoma
  desde ahi y esto no aplica.
- Piso temporal: `EDA_CONSUMER_SINCE` (ISO 8601 con zona: `Z` u offset; si
  no, el arranque falla, y también si la fecha está en el futuro). Los mensajes
  con timestamp de Kafka anterior se saltean sin decodificarlos y el offset
  avanza; los que no traen timestamp real (`-1`, vacío) se procesan.
  **Tiene que quedar cargada siempre**: Kafka borra los offsets de un grupo que
  pasa 7 días sin consumidores (con Render free y el keep-warm solo de jueves,
  pasa) y un `OffsetOutOfRange` también vuelve a leer desde el principio. Sirve para no procesar los eventos de prueba viejos al leer desde el
  principio. Vacio = sin piso (la dedup por `eventId` cubre los repetidos).

## Agregar una regla

Crear `<evento>/rules/<regla>.rule.js` exportando una subclase de
`BusinessRule` (cuando aplica y que resultado devuelve):

```js
const { BusinessRule } = require('../../../business-rule');

class CapacidadAlta extends BusinessRule {
  appliesTo({ data }) {
    return data.capacidad >= 500;
  }

  apply({ data }) {
    return { type: 'ProgramarCobertura', payload: { eventoId: data.eventoId, capacidad: data.capacidad } };
  }
}

module.exports = { CapacidadAlta };
```

No hay que registrarla: el listener carga todos los `*.rule.js` de su carpeta
al arrancar, en orden alfabetico (prefijar con `01-`, `02-`... si el orden de
los resultados importa). Un archivo que no exporte exactamente una subclase de
`BusinessRule` hace fallar el arranque del listener. Otros archivos de la
carpeta (helpers, constantes) se ignoran.

Cada `type` que devuelva una regla necesita su handler registrado en el
`OutcomeFactory` (`src/index.js`).

## Agregar un listener

1. Crear `<caso-de-negocio>/<evento>/<evento>.listener.js` extendiendo
   `EventListener`, pasando `topic` (en general desde una env var) y
   `rulesDir: path.join(__dirname, 'rules')`.
2. Sumarlo al array `listeners` del `index.js` del subpaquete.
3. Si el caso de negocio es nuevo, agregar su carpeta a `PACKAGES` en `index.js`.
4. Tests en `src/tests/listeners/<caso-de-negocio>/`.

Un error transitorio en `handle()` o en la factory hace que Kafka reentregue
el mensaje; uno permanente lo descarta (ver Errores).
