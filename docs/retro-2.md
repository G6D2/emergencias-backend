# Retrospectiva simulada — después del Hito 1

Tramo evaluado: los cuatro sprints del Hito 1 (27/08 al 23/09) y la entrega del 24/09. Entre 27
y 53 commits por semana, con 5 o 6 personas activas en cada sprint.

## Qué entregamos

- MVP standalone en producción: botón de pánico, reporte, mis alertas, cancelación, central del
  dispatcher, asignación de oficiales, mapa e historial.
- Motor de incidentes con DBSCAN y prioridad efectiva visible en la central.
- Login con email y contraseña, perfil ciudadano y ubicación cifrados.
- Once ADRs publicados en el registro.

## Qué funcionó

- Cuatro sprints seguidos con ritmo parejo y casi todo el equipo.
- Escribir el ADR antes del código: DBSCAN se decidió el 09/09 y estaba en producción el 23/09.
- La revisión de Producto sobre los ADRs encontró errores reales (workflows mal contados, un gate
  de cobertura que no podía bloquear nada).
- La demo salió completa porque el backend se despertó antes de la clase.

## Qué no funcionó

- Cerramos tarde: el ADR de Next.js y el BFF llegó aprobado pero sin mergear el día de la
  entrega, porque esperaba la revisión del code owner.
- Decisiones tomadas y no registradas: el día del hito había 17 decisiones y 11 publicadas.
- La aprobación obligatoria de los PRs no se puede activar en repos privados del plan free, y el
  ADR que la exige dice lo contrario.
- El BFF reintenta los POST mientras el backend despierta; un SOS se podría duplicar.

## Acciones

| Acción | Responsable | Cómo sabemos que se cumplió |
|---|---|---|
| Mergear los ADRs aprobados pendientes | Scrum Master | ADR de Next.js y BFF aceptado en el registro |
| Pasar a ADR las tres propuestas de seguridad (cifrado, identidad local, autorización) | Seguridad | Tres ADRs nuevos en el registro |
| Escribir los ADRs de diseño del Hito 2 antes de integrar con otros grupos | Producto / Back | ADRs de listeners y de prioridad por contexto antes del código del consumer |
| Decidir qué hacemos con la aprobación de PRs (repos públicos, otro plan o acuerdo escrito) | Scrum Master / Producto | ADR que reemplaza a "Requerir aprobación de Producto en los PRs" |
| Que el backend respete `Idempotency-Key` en el alta del SOS | Back | Alta del SOS deduplicada por clave |
