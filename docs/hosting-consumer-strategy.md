# Estrategia de hosting y consumer de eventos

**Estado:** propuesta técnica del 21/09/2026 (Hito 1). La parte de "qué existe hoy" quedó vieja: ver abajo.
**Autor:** DevOps (Kevin)
**Contexto:** hallazgo #17 — "El hosting actual se presenta como solución compatible con consumo continuo de eventos"

## Estado al 05/11/2026

Lo que este documento describe como inexistente ya está en `main` y en producción:

- **Hay consumer Kafka.** `src/listeners/` (cobertura preventiva) consume `EventoComunitarioPublicado`
  y `EventoCancelado` de Espacios. Corre **dentro del mismo servicio web** de Render (free), no en
  un worker aparte: no se implementó el escenario B tal como está escrito.
- **El broker es el bus del Grupo 1** (`test.citypass.mrfranco.net.ar:9092`, SASL/OAUTHBEARER +
  SSL, Avro con schema registry), no Upstash ni un Kafka propio.
- **Kafka está prendido** (`KAFKA_ENABLED=true`, `KAFKA_CONSUMER_ENABLED=true`), pero el outbox
  **no publica** (`OUTBOX_PUBLISHER_ENABLED=false`): los eventos propios siguen quedando `PENDING`
  en `outbox_events`.
- Los tópicos `emergencias.cerrada` y `TOPIC_EMERGENCIA_CERRADA` ya no existen: el cierre viaja
  como `EmergenciaActualizada` (ver `docs/diagramas/06-eventos.md`).

El problema de fondo del punto 1 sigue igual: Render free duerme sin tráfico, y mientras duerme el
consumer no lee. Al despertar sigue desde el último offset confirmado de su consumer group, así
que los eventos no se pierden mientras el broker los retenga, pero llegan con demora. El
keep-warm solo cubre la ventana de clase.

El resto del documento se conserva como estaba, como registro de la decisión del Hito 1.

## Problema (al 21/09/2026)

Hoy presentamos el stack de producción (Render + Kafka) como si soportara consumo continuo de eventos. Dos cosas rompen ese discurso:

1. **Render free tier duerme** tras ~15 min sin tráfico HTTP (arranque en frío 50-60s). El
   keep-warm in-process (`src/jobs/keep-warm.js`) y el cron de GitHub Actions
   (`.github/workflows/keep-warm.yml`) lo mantienen despierto solo en la ventana horaria de
   clase (`KEEP_WARM_WINDOWS=jue:17:00-23:30`).
2. **No existe consumer Kafka** en el código. El backend solo publica al `outbox_events` con un
   poller de 5s (`src/services/outbox-publisher.js`) y con `KAFKA_ENABLED=false` en
   `render.yaml`: ningún evento sale del outbox hoy. Analítica (Grupo 8) no puede consumir
   nada aunque quisiera.

Un consumer necesita proceso **always-on** (`consumer.run()` mantiene una long-poll contra el
broker). Render free no lo garantiza. Cuando aparezca el consumer real —para integración con
Grupo 8 o para acciones internas basadas en eventos externos— necesitamos otra estrategia.

## Componentes a alojar

| Componente | Estado hoy | Requisito |
|---|---|---|
| Backend HTTP (`emergencias-backend`) | Render web free | Puede tolerar sleep; keep-warm mitiga |
| Frontend Next.js | Render web free | Igual que backend |
| PostgreSQL | Neon (external, plan free) | Always-on gestionado por Neon |
| **Kafka broker** | Docker Compose local | En producción: no existe |
| **Kafka consumer(s)** | No existe | Always-on, sin sleep |

## Opciones de compute para el consumer

| Opción | Costo mensual | Always-on | Setup | Trade-off |
|---|---|---|---|---|
| **Render Starter** | ~USD 7 por servicio | Sí | Mínimo (mismo dashboard, `plan: starter` en `render.yaml`) | Simple; sumamos ~USD 7-14 al stack |
| **Fly.io Hobby** | USD 0-5 según recursos | Sí | Medio (Dockerfile, `fly.toml`) | Más flexible, buena para background workers |
| **Railway** | USD 5 free credit inicial + uso | Sí | Fácil (import de repo GitHub) | Después del credit paga por uso |
| **GCP Cloud Run** | Prácticamente USD 0 con uso bajo | Escala a cero por defecto | Medio (imagen container + IAM) | Puede correr como "always-on" pagando por instancia; sirve muy bien para eventos pub/sub, no tanto para Kafka pull |
| **VPS propio (Hetzner/DO)** | USD 4-6 | Sí | Alto (systemd, monitoreo, TLS) | Máximo control, mucho overhead operativo |
| **GitHub Actions cron** | Gratis (2000 min/mes) | ❌ (batch cada N min) | Muy bajo | Solo sirve si aceptamos consumo pull-mode con latencia; no es "consumer continuo" |

## Opciones de broker Kafka managed

| Opción | Costo | Setup | Trade-off |
|---|---|---|---|
| **Upstash Kafka** | Free tier 10K msg/día, 256 MB retención | Muy fácil (REST + Kafka wire) | Ideal para volumen de aula; free suficiente para la demo |
| **Confluent Cloud** | USD 400 de credit inicial (~4 meses) | Medio | Kafka "real"; después del credit paga |
| **Redpanda Cloud** | Free tier limitado | Fácil | Compatible protocolo Kafka; alternativa liviana |
| **Aiven** | Trial USD 300 | Medio | Después del trial paga |
| **AWS MSK** | > USD 100/mes | Alto | Overkill para el proyecto |
| **Kafka self-hosted en Render/VPS** | Costo del compute | Alto | No recomendado: Kafka+Zookeeper corriendo en free tier es inviable |

## Escenarios propuestos

### Escenario A — Hito 1 (no gastar plata, presentar honestamente)

- No implementar consumer todavía. Publicar solo al outbox (ya hecho) y presentar Kafka como
  **arquitectura objetivo del Sprint 3**, no como implementación actual.
- Ajustar discurso de ADR-005 y de la PPT: "eventos se persisten en outbox; integración con
  bus queda para Sprint 3".
- Grupo 8 (Analítica), si necesita algo YA, puede consultar por HTTP directo contra un
  endpoint de lectura del outbox mientras tanto (evaluar impacto de exponer eso).
- **Costo:** USD 0. **Riesgo:** ninguno técnico. **Bloqueado por:** decisión de Producto.

### Escenario B — Hito 2/3 con consumer real (mínimo viable)

- **Broker:** Upstash Kafka (free tier). Un tópico por evento (`emergencias.boton-panico`,
  `emergencias.estado-actualizado`, `emergencias.cerrada` — los que había en `render.yaml` en
  ese momento; `emergencias.cerrada` ya no existe).
- **Backend HTTP:** seguir en Render free + keep-warm (funciona hoy).
- **Consumer:** proceso Node.js separado (`src/services/consumer.js`, nuevo) en:
  - **Preferido:** Render Starter (~USD 7/mes) — mismo dashboard, `plan: starter` en un
    nuevo servicio background worker.
  - **Alternativa:** Fly.io Hobby si Render Starter no está en presupuesto.
- **Costo:** USD 0-7/mes. **Riesgo bajo:** solo un servicio nuevo, resto del stack no cambia.

### Escenario C — Todo containerizado (para cuando queramos "imagen inmutable" del hallazgo #36)

- Empaquetar backend + consumer + (opcional) frontend como imágenes Docker.
- Publicar a GHCR desde CI.
- Deployar a Fly.io o Cloud Run.
- Beneficio: promoción de artefacto real, no rebuild en cada deploy.
- **Costo:** similar a B, pero más setup. **Riesgo:** medio, cambia el modelo de deploy.
- Recomendación: **no hacerlo ahora**. Documentar como roadmap.

## Recomendación

Para la **entrega inmediata (Hito 1)**: **Escenario A**. No cambia el stack, corrige el
discurso, alinea con la realidad del código. Sin decisión de Producto sobre el consumer, no
tiene sentido gastar en un broker managed ni en compute extra.

Para **Hito 2 en adelante**: **Escenario B** cuando Producto decida:
1. Qué evento externo consume el módulo (viene de Analítica? de otro grupo?).
2. Qué acción produce el consumo (persiste en tabla propia? dispara notificación? actualiza
   estado?).
3. Qué garantías necesitamos (at-least-once, orden, idempotencia).

Sin esas tres decisiones cerradas, cualquier trabajo de infra del consumer es prematuro.

## Preguntas para la reunión con Producto/Backend

1. ¿Alguien externo (Analítica, Notificaciones) va a producir eventos que este módulo debe
   consumir? Si sí, ¿cuáles y con qué contrato?
2. ¿Está aceptado presentar Kafka como "arquitectura objetivo" y no como implementación
   activa para Hito 1?
3. Presupuesto: ¿el equipo puede sumar USD 7-14/mes para servicios always-on cuando
   implementemos el consumer, o buscamos estrictamente free tier?
4. ¿Analítica prefiere consumir por Kafka o le sirve un endpoint HTTP de solo lectura sobre
   el outbox mientras tanto?

## Referencias

- Hallazgo #17, #22, #25 (documento de hallazgos)
- `render.yaml` — configuración actual del backend
- `src/services/outbox-publisher.js`, `src/services/kafka.service.js` — código de publicación
- `src/jobs/keep-warm.js`, `.github/workflows/keep-warm.yml` — mitigación de sleep en free
- `docs/diagramas/06-eventos.md` — eventos publicados hoy
- `docs/diagramas/08-despliegue.md` — mapa de servicios y variables actuales
