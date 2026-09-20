# CI/CD

Para qué sirve: mostrar los pipelines reales de GitHub Actions de los dos repos (`.github/workflows/*.yml`),
sus jobs, pasos y gates, para entender qué bloquea un merge y qué dispara un deploy.

```mermaid
flowchart TB
    subgraph backendCI["emergencias-backend · CI (ci.yml)"]
        direction TB
        bTrigger["on: pull_request -> main, push a main"]
        bValidate["validate-pr<br/>título y descripción no vacíos"]
        bLint["lint-and-test<br/>servicio postgres:15-alpine"]
        bSteps["npm ci -> lint -> migrate -> unit tests (jest --coverage) -> integration tests"]
        bGate["gate: coverage 80% lines/branches/functions/statements<br/>(jest coverageThreshold, falla el job)"]
        bComment["comentario de cobertura en el PR + artefacto coverage-backend"]
        bSonar["SonarCloud (solo si SONAR_TOKEN existe, continue-on-error)"]
        bNotify["notify-failure -> email si algo falló"]

        bTrigger --> bValidate
        bTrigger --> bLint
        bLint --> bSteps --> bGate --> bComment --> bSonar
        bValidate -.-> bNotify
        bLint -.-> bNotify
    end

    subgraph backendCD["emergencias-backend · CD (cd.yml)"]
        direction TB
        bCdTrigger["on: push a main"]
        bMigrate["npm run migrate (Flyway, DATABASE_URL secret)"]
        bDeploy["curl deploy hook de Render (si RENDER_DEPLOY_HOOK_URL existe)"]
        bCdNotify["notify-failure -> email"]

        bCdTrigger --> bMigrate --> bDeploy
        bDeploy -.-> bCdNotify
    end

    subgraph backendKW["emergencias-backend · Keep-warm (keep-warm.yml)"]
        direction TB
        kwCron["cron jueves 19:50 UTC + 20:00-23:59 UTC cada 20min + workflow_dispatch"]
        kwPing["GET BACKEND_URL/health + GET FRONTEND_URL/api/warmup"]
        kwCron --> kwPing
    end

    subgraph frontendCI["Frontend · CI (ci.yml)"]
        direction TB
        fTrigger["on: pull_request -> main, push a main"]
        fValidate["validate-pr<br/>título y descripción no vacíos"]
        fLint["lint-and-test"]
        fSteps["npm ci -> lint -> build -> vitest run --coverage -> integration tests"]
        fGate["gate: coverage 80% (vitest thresholds, falla el job)"]
        fComment["comentario de cobertura en el PR + artefacto coverage-frontend"]
        fSonar["SonarCloud (solo si SONAR_TOKEN existe, continue-on-error)"]
        fNotify["notify-failure -> email"]

        fTrigger --> fValidate
        fTrigger --> fLint
        fLint --> fSteps --> fGate --> fComment --> fSonar
        fValidate -.-> fNotify
        fLint -.-> fNotify
    end

    subgraph frontendCD["Frontend · CD (cd.yml)"]
        direction TB
        fCdTrigger["on: push a main"]
        fDeploy["curl deploy hook de Render (si RENDER_DEPLOY_HOOK_URL existe)<br/>sin paso de migración"]
        fCdNotify["notify-failure -> email"]

        fCdTrigger --> fDeploy
        fDeploy -.-> fCdNotify
    end

    bDeploy -.->|"despierta al front"| kwPing
    bMigrate -->|"mismo Neon"| sharedDb[("Neon Postgres")]

    activateBackup["Job de activate-backup"]:::missing
    activateBackup -.->|"no existe ningún workflow así en el repo"| backendCD

    classDef missing fill:#ffe3e3,stroke:#e03131,color:#7d1a1a,stroke-width:1px,stroke-dasharray: 2 2;
```

## Gates que bloquean un merge

| Gate | Dónde | Qué pasa si falla |
|---|---|---|
| Título/descripción de PR no vacíos | `validate-pr` (back y front) | Falla el job, no bloquea el merge por sí solo pero dispara `notify-failure` |
| Lint (`eslint`) | `lint-and-test` | Falla el job |
| Migraciones aplican limpio contra Postgres efímero | `lint-and-test` (solo backend, servicio `postgres:15-alpine`) | Falla el job antes de llegar a los tests |
| Cobertura de tests **80%** en statements/branches/functions/lines | `jest coverageThreshold` (back) / `vitest coverage.thresholds` (front) | El comando de test sale con código de error, el job falla |
| Tests de integración | `lint-and-test` (`npm run test:integration` / `vitest run --config vitest.integration.config.mjs`) | Falla el job |
| SonarCloud | `lint-and-test`, paso final | **No bloquea**: `continue-on-error: true` y solo corre si hay `SONAR_TOKEN` |

## CD

| Repo | Trigger | Pasos | Nota |
|---|---|---|---|
| `emergencias-backend` | `push` a `main` | `npm run migrate` (Flyway contra `DATABASE_URL` secret) → deploy hook de Render | Sin `FLYWAY_BASELINE_VERSION` a propósito (ver comentario en `cd.yml`): una base nueva necesita correr V1..V13 completas |
| `Frontend` | `push` a `main` | Deploy hook de Render únicamente | No corre migraciones (no tiene schema propio) |

Ninguno de los dos `cd.yml` tiene un job de `activate-backup` ni ningún paso que apunte a una
segunda cuenta de Render: se buscó explícitamente y no aparece en ningún workflow de ninguno de
los tres repos clonados (`emergencias-backend`, `Frontend`, `ADRs`). Se deja marcado en el
diagrama como **no encontrado**, no como "deshabilitado".

## Fuente en el código

- `.github/workflows/ci.yml`, `.github/workflows/cd.yml`, `.github/workflows/keep-warm.yml` (`emergencias-backend`)
- `Frontend/.github/workflows/ci.yml`, `Frontend/.github/workflows/cd.yml`
- `package.json` (`jest.coverageThreshold`) y `Frontend/vitest.config.mjs` (`coverage.thresholds`)
- `sonar-project.properties` (backend y frontend)
