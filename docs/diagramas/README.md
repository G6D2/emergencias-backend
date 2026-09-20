# Diagramas — Hito 1

Documentación técnica generada a partir del código real de `emergencias-backend` y `Frontend`
(commits de main al 2026-09-20), en [Mermaid](https://mermaid.js.org/) para que GitHub los
renderice directo en el repo, sin herramientas externas.

Cada archivo trae: título, para qué sirve, el diagrama, una tabla/leyenda corta y una sección
"Fuente en el código" con paths reales. Donde el documento de producto describe algo que el
código todavía no tiene, queda marcado explícitamente como **previsto** o **parcial** — nada
de lo que aparece como implementado es especulación.

## Índice

1. [Casos de uso](01-casos-de-uso.md) — actores, épicas y qué caso de uso está implementado vs. planificado
2. [Modelo entidad-relación](02-modelo-entidad-relacion.md) — schema completo de las 13 migraciones Flyway
3. [Arquitectura](03-arquitectura.md) — contenedores (estilo C4) y componentes internos del backend
4. [Máquina de estados](04-maquina-de-estados.md) — transiciones de una emergencia, con y sin endpoint
5. [Secuencias](05-secuencias.md) — SOS del ciudadano, flujo del dispatcher, cancelación + outbox→Kafka
6. [Eventos de dominio](06-eventos.md) — qué se publica hoy y su brecha contra el contrato de Analítica
7. [CI/CD](07-ci-cd.md) — pipelines reales de backend y frontend, con sus gates
8. [Despliegue](08-despliegue.md) — Render, Neon, GitHub Actions, SonarCloud y variables de entorno

## Cómo se validó el Mermaid

Cada bloque ` ```mermaid ` de estos 8 archivos se extrajo a un `.mmd` y se renderizó con
`@mermaid-js/mermaid-cli` (`npx -y @mermaid-js/mermaid-cli -i archivo.mmd -o archivo.svg`) antes
de commitear: todos generan SVG sin errores de sintaxis.

## Cómo se generaron

A partir de: migraciones (`db/migrations/V*.sql`), dominio (`src/domain/*.js`), rutas
(`src/routes/*.js`), servicios y seguridad (`src/services/*.js`, `src/security/*.js`),
workflows (`.github/workflows/*.yml`) de este repo y de `Frontend`, más los documentos de
producto (`Grupo 6 - Emergencias - Casos de Uso.md`, `Emergencias - Roadmap y Historias de
Usuario.md`, `tableros-analitica.md`) para contrastar lo documentado contra lo implementado.
