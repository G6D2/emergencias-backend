# Diagramas — Hito 1

Documentación técnica generada a partir del código real de `emergencias-backend` y `Frontend`
(commits de main al 2026-09-20, actualizada al 2026-09-21 para incorporar el motor de
incidentes de los PRs #36/#39/#41, `address` cifrado del PR #37 y el workflow `activate-backup`
del PR #38; actualizada de nuevo al 2026-09-23 para incorporar `DbscanGrouper` e
`IncidentDetectionStrategy` del PR #51, verificado en producción ese mismo día), en
[Mermaid](https://mermaid.js.org/) para que GitHub los renderice directo en el repo, sin
herramientas externas.

Cada archivo trae: título, para qué sirve, el diagrama, una tabla/leyenda corta y una sección
"Fuente en el código" con paths reales. Donde el documento de producto describe algo que el
código todavía no tiene, queda marcado explícitamente como **previsto** o **parcial** — nada
de lo que aparece como implementado es especulación.

## Índice

1. [Contexto (C4 nivel 1)](00-contexto.md) — el módulo en el mapa de CityPass+: actores, sistemas propios y externos, qué está conectado hoy
2. [Casos de uso](01-casos-de-uso.md) — actores, épicas y qué caso de uso está implementado vs. planificado
3. [Modelo entidad-relación](02-modelo-entidad-relacion.md) — schema Flyway (V1…V16: emergencias, outbox, officers, incidents, perfil, auth local)
4. [Arquitectura](03-arquitectura.md) — contenedores (estilo C4) y componentes internos del backend, incluido el motor de incidentes con `IncidentDetectionStrategy` (`DbscanGrouper` primaria, `RuleBasedGrouper` fallback)
5. [Máquina de estados](04-maquina-de-estados.md) — transiciones de una emergencia, con y sin endpoint
6. [Secuencias](05-secuencias.md) — SOS del ciudadano, flujo del dispatcher, cancelación + outbox→Kafka, job de detección de incidentes (DBSCAN con fallback a reglas)
7. [Eventos de dominio](06-eventos.md) — qué se publica hoy (incluido `EmergenciaPriorizada`) y su brecha contra el contrato de Analítica
8. [CI/CD](07-ci-cd.md) — pipelines reales de backend y frontend, con sus gates, y el workflow manual de failover
9. [Despliegue](08-despliegue.md) — Render (primario y backup), Neon, GitHub Actions, SonarCloud y variables de entorno

## Cómo se validó el Mermaid

Cada bloque ` ```mermaid ` de estos 8 archivos se extrajo a un `.mmd` y se renderizó con
`@mermaid-js/mermaid-cli` (`npx -y @mermaid-js/mermaid-cli -i archivo.mmd -o archivo.svg`) antes
de commitear: todos generan SVG sin errores de sintaxis.

## Cómo se generaron

A partir de: migraciones (`db/migrations/V*.sql`, incluida V14 del motor de incidentes,
V15 de perfil ciudadano y V16 de auth local),
dominio (`src/domain/*.js`, incluidos `rule-based-grouper.js`, `dbscan-grouper.js`,
`incident-detection-strategy.js`, `risk-engine.js`, `incident-detector.js`), `scripts/demo-dbscan.js`
(dataset sintético de demo), rutas (`src/routes/*.js`, incluido `incidents.routes.js`), servicios y
seguridad (`src/services/*.js` — incluido `incident-detection-job.js` —, `src/security/*.js`),
workflows (`.github/workflows/*.yml`, incluido `activate-backup.yml`) de este repo y de
`Frontend`, más los documentos de producto (`Grupo 6 - Emergencias - Casos de Uso.md`,
`Emergencias - Roadmap y Historias de Usuario.md`, `tableros-analitica.md`) para contrastar lo
documentado contra lo implementado.
