# Trade-off: doble build en CI/CD

**Estado:** decisión aceptada — Hito 1
**Autor:** DevOps (Kevin)
**Contexto:** hallazgo #36 — "El pipeline promueve exactamente el artefacto que fue validado por CI"

## Qué se afirmó y qué pasa en la realidad

Se dijo que el CD despliega **el mismo artefacto** que CI validó. Eso no es cierto hoy: CI y CD ejecutan builds independientes desde el mismo commit fuente.

### Lo que hace CI (en la corrida del PR/push)

- **Backend (`emergencias-backend/.github/workflows/ci.yml`):**
  1. `npm ci`
  2. `npm run lint`
  3. `npm run migrate` (Flyway contra Postgres efímero)
  4. `npm test` (unit + cobertura)
  5. `npm run test:integration`
- **Frontend (`Frontend/.github/workflows/ci.yml`):**
  1. `npm ci`
  2. `npm run lint`
  3. `npm run build` (**esto es un `next build` completo**)
  4. `npm run test:coverage`
  5. `npm run test:integration`

CI valida el commit pero **no publica ningún artefacto reusable** (imagen Docker, tarball, archivo estático versionado). La salida del build queda solo en el runner efímero de GitHub Actions.

### Lo que hace CD (después de que el commit va a main)

- Con los cambios del hallazgo #34, CD se dispara vía `workflow_run` cuando CI termina en `success`.
- Backend: corre migraciones y hace `POST` al deploy hook de Render.
- Frontend: hace `POST` al deploy hook.

El deploy hook le dice a Render "empezá a construir el commit HEAD de main". Render entonces:
1. Clona el repo en su propio worker.
2. Construye: en backend, la imagen del `Dockerfile` (`npm ci --only=production` + `COPY src`); en frontend, el `buildCommand` (`next build`).
3. Levanta el proceso (`CMD` del `Dockerfile` en backend, `startCommand` en frontend).

**Es un segundo `npm ci` + `next build` completamente independiente del que corrió CI.**

## Por qué no es "promoción de artefacto"

Un pipeline con promoción de artefacto real tiene esta forma:

1. CI construye un artefacto inmutable (imagen Docker, tarball, JAR).
2. CI publica el artefacto a un registry versionado (GHCR, ECR, S3).
3. CD **descarga y despliega ese artefacto**, sin volver a construir.

Beneficios que hoy **no tenemos**:

- **Determinismo:** el binario que se despliega es byte-a-byte el que se testeó. Hoy podría diferir por versión de Node en Render vs GH Actions, timestamps, orden no determinístico de dependencias, `postinstall` scripts, etc.
- **Trazabilidad:** cada deploy tiene un tag/hash de imagen asociado a un commit. Hoy la única traza es "el hook aceptó el POST en tal fecha".
- **Rollback rápido:** revertir es re-desplegar la imagen anterior. Hoy hay que revertir el commit y esperar el rebuild.
- **Menor exposición a "flaky builds" en el paso de deploy:** si `npm install` de Render falla por un mirror caído, no afecta un artefacto ya construido.

## Trade-off aceptado para Hito 1

**Aceptamos el doble build.** Razones:

1. **Costo del cambio:** implementar imagen inmutable requiere Docker también en el frontend (el backend ya se construye con su `Dockerfile` en Render), publicación a GHCR, cambiar `render.yaml` para consumir imagen en vez de repo, y aprender el ciclo `pull → deploy` de Render con imágenes (soportado, pero es distinto al hook actual).
2. **Beneficio marginal para el volumen actual:** dos builds seguidos toman 2-4 min extras y no somos production-critical. Ninguna de las regresiones que un artefacto inmutable previene apareció en las corridas hasta ahora.
3. **El delta CI vs Render es acotado hoy:** ambos usan Node 20 y `npm ci`. La probabilidad de que un build pase en CI y falle en Render por diferencia de entorno es baja.

## Cuándo migrar a artefacto inmutable

Cuando entre alguna de estas condiciones:

- **Rollbacks manuales sean frecuentes** — necesitamos revert rápido.
- **Ambientes múltiples aparezcan** (staging + prod) — un mismo artefacto debe promoverse.
- **Un incidente muestre divergencia CI/prod** — build verde en CI, roto en Render por variación de entorno.
- **Empecemos a shipear al backup site** (hallazgo #17 escenario B, backup site en Kevin) — un mismo artefacto debe deployar a las dos cuentas.

## Cómo se implementaría (roadmap Sprint 3+)

1. `Dockerfile` en cada repo (multi-stage: build → runtime slim).
2. Job en CI que buildea y pushea a `ghcr.io/g6d2/<repo>:<sha>` en pushes a main.
3. Render pasa a modo "image" en vez de "repo":
   - `render.yaml` con `image: url: ghcr.io/g6d2/<repo>:{{sha}}`.
   - Autenticación de Render a GHCR con un PAT de solo-lectura.
4. CD deja de hacer `POST` al hook; en su lugar hace `PATCH` a la API de Render actualizando la tag de imagen (Render trigger deploy automáticamente).
5. Rollback: `PATCH` con la tag anterior.

Esfuerzo estimado: ~1-2 días de DevOps.

## Referencias

- Hallazgo #36
- `.github/workflows/ci.yml`, `.github/workflows/cd.yml` (ambos repos)
- `render.yaml` (ambos repos)
- `docs/hosting-consumer-strategy.md` (hallazgo #17, escenario C toca lo mismo)
- `docs/diagramas/07-ci-cd.md` (pipelines actuales)
