# Guion de demo: DBSCAN en vivo

Tres ciudadanos reportan el mismo hecho, uno detrás del otro y a menos de 75 m entre sí. En menos de
dos minutos, el tablero del despachador muestra un incidente con su score y la prioridad elevada.
Dura unos 4 minutos. Las coordenadas son las de `scripts/demo-dbscan.js` (Obelisco). Cómo se
eligieron los parámetros está en [calibracion-dbscan.md](calibracion-dbscan.md).

## Cómo nace un incidente

No lo crea el alta. `POST /api/panic-button` guarda la emergencia en `PENDING` y nada más. El
incidente lo crea el job de detección, que corre cada 60 s (la primera pasada, 15 s después de que
arranca el backend). En cada pasada:

1. Trae las emergencias de los últimos 15 min que no estén cerradas, canceladas ni descartadas.
2. Las separa por tipo.
3. DBSCAN junta las que están a menos de 300 m, con al menos 2 ciudadanos distintos.
4. El Risk Engine calcula el score y la prioridad del incidente, con todos sus miembros activos
   (también los que ya salieron de la ventana).

El front del despachador vuelve a pedir la lista cada 30 s. Entre el segundo reporte y el incidente
en pantalla pasan, como mucho, unos 90 s.

## Preparación (10 minutos antes)

1. **Despertar el backend.** Render free duerme sin tráfico. Abrir
   `https://emergencias-backend-34go.onrender.com/health` y esperar `"status":"ok"`. Los jueves de
   17:00 a 23:30 lo mantiene despierto el keep-warm.
2. **Despachador.** En `/acceso`, entrar por Login Federado con el usuario LDAP de despachador
   (`juan-trabaja`, que tipea la contraseña quien presenta) y dejar abierta `/ops/lista`.
3. **Tres ciudadanos, en tres perfiles de Chrome o ventanas de incógnito separadas.** En `/acceso`,
   panel de la llave: "Ciudadano con SOS" (JuanPanico), "Ciudadano anónimo" (`U000042`) y, en
   "Cuentas ciudadanas", LuciaTranquila → Cargar → Iniciar sesión. Tienen que ser tres cuentas
   distintas: un mismo ciudadano reportando dos veces no cuenta.
4. **Fijar la ubicación de cada navegador.** `/reportar` toma la ubicación del navegador al abrir
   la pantalla. En una notebook, esa ubicación sale del wifi o de la IP y puede errar por
   kilómetros. En cada perfil: DevTools → ⋮ → More tools → Sensors → Location → Other…, cargar la
   latitud y longitud de la tabla de abajo y **recién después** abrir (o recargar) `/reportar`.
5. **Limpiar ensayos.** Cancelar cualquier reporte de prueba del mismo tipo hecho cerca en los
   últimos 15 min. Si queda activo, se suma al incidente de la demo.

## Coordenadas y tiempos

Los tres eligen **"Disturbio o evento"** en `/reportar` (`DISTURBIO_EVENTO_MASIVO`, severidad
Media). No usar el SOS: solo JuanPanico lo tiene, `PANICO` no se agrupa con otro tipo y, como ya es
Crítica, no se vería la suba.

| Paso | Ciudadano | Latitud | Longitud | Cuándo | Distancia a los otros |
|---|---|---|---|---|---|
| 1 | JuanPanico | -34.6037 | -58.3816 | t = 0 | — |
| 2 | LuciaTranquila | -34.6033 | -58.3816 | t ≈ 30 s | 44 m del 1 |
| 3 | Ciudadano anónimo | -34.6037 | -58.3810 | t ≈ 60 s | 55 m del 1 y 71 m del 2 |

## Qué se ve en el tablero

Recargar `/ops/lista` (o esperar el refresco de 30 s) y volver a hacer clic en la fila para ver el
detalle actualizado.

- **Al minuto del segundo reporte:** las dos filas muestran la pastilla violeta "Incidente · 2
  reportes" y la prioridad pasa de Media a **Alta**. Score ≈ 62.
- **Al minuto del tercero:** "Incidente · 3 reportes". En el detalle, el bloque "Incidente
  detectado" muestra Reportes 3, Ciudadanos únicos 3 y **Score ≈ 70**. También aparecen los motivos
  "Múltiples reportes", "Reportado por varios ciudadanos" y "Reportes cercanos entre sí", y la línea
  "Prioridad elevada por incidente (era Media)".
- **En `/ops/mapa`:** los tres puntos juntos, cada popup con "Incidente · 3 reportes".

Si cerca del Obelisco hay un contexto de zona vigente (un evento en un espacio público o una alerta
climática), la prioridad mostrada sube un nivel más (Alta pasa a Crítica) y aparece la pastilla
ámbar "Evento en la zona" o "Alerta climática". Eso no lo hace DBSCAN: conviene aclararlo si pasa.

De dónde sale el 70: 3 reportes × 5 = 15; 3 ciudadanos × 8 = 24; cercanía 20 × (1 − 71/100) ≈ 6
(los reportes más alejados están a 71 m); recencia ≈ 15; severidad Media = 10. El score baja
alrededor de 1 punto por minuto, porque la recencia pesa cada vez menos, hasta ≈ 55 a los 16
minutos. Ahí queda fijo y en **Alta**, con los 3 reportes: el job puntúa el incidente con todos
sus miembros, también los que ya salieron de la ventana de 15 minutos. No hace falta apurarse a
mostrarlo.

## Qué decir

> "Estos tres reportes los mandan tres personas distintas, a menos de 75 metros y en un minuto.
> Ningún operador los juntó: cada minuto el backend corre DBSCAN sobre los reportes recientes del
> mismo tipo y detecta que forman un grupo denso. DBSCAN solo decide quién va con quién. El score lo
> calcula un motor de reglas determinístico, que guarda los motivos y nunca baja la prioridad
> individual de un reporte. Los parámetros (300 m, 2 ciudadanos, 15 minutos) los calibramos con un
> dataset sintético, y lo decimos así: son datos generados, no de la ciudad."

## Si no agrupa

| Qué se ve | Causa probable | Qué hacer o decir |
|---|---|---|
| Nada después de 2 min | El job todavía no corrió: el backend recién despertó o hay un error | Recargar y esperar un minuto más. En los logs de Render, buscar "Incident detection job failed" |
| Uno quedó afuera | Eligió otro tipo (por ejemplo, SOS) | "Se agrupa dentro del mismo tipo: un SOS y un disturbio no se mezclan". Repetir con "Disturbio o evento" |
| Uno quedó afuera | Su ubicación no es la de la tabla (no se fijó en Sensors y la notebook ubicó por wifi o IP) | Mirar la dirección en el detalle. "El radio es de 300 m: este reporte cayó lejos" |
| Uno quedó afuera | Pasaron más de 15 min entre ese reporte y los otros | "La ventana es de 15 minutos: un reporte que llega cuando los demás ya salieron de la ventana no tiene con quién juntarse" |
| Hay un reporte de más | Un ensayo del mismo tipo, activo, a menos de 300 m y 15 min | Cancelarlo. Explicarlo como lo que es: el algoritmo lo agrupó bien |
| No se forma con dos | Los dos reportes son del mismo ciudadano | "Hacen falta al menos dos personas distintas: un mismo usuario apretando dos veces no arma un incidente" |
| Una emergencia sale del incidente | Alguien la descartó, cerró o canceló durante la demo | Las terminales salen de los candidatos |

Si preguntan **qué pasa si DBSCAN falla**: el job cae al fallback (`RuleBasedGrouper`), que en este
escenario arma exactamente el mismo grupo, y el incidente queda con `algorithmVersion` =
`rule-based-v1` en vez de `dbscan-v1`. El fallback nunca es la causa de que no se agrupe: se activa
solo ante una excepción y, cuando corre, agrupa igual.

## Plan B sin front

Si el front falla, los mismos tres reportes por API (con `curl` y `jq`):

```bash
API=https://emergencias-backend-34go.onrender.com
tok() { curl -s -X POST "$API/auth/dev/login" -H 'Content-Type: application/json' \
  -d "{\"sub\":\"$1\"}" | jq -r .access_token; }
reportar() { curl -s -X POST "$API/api/panic-button" -H "Authorization: Bearer $(tok "$1")" \
  -H 'Content-Type: application/json' \
  -d "{\"emergencyType\":\"DISTURBIO_EVENTO_MASIVO\",\"location\":{\"latitude\":$2,\"longitude\":$3},\"description\":\"Demo DBSCAN (datos de prueba)\"}" \
  | jq -r .emergencyId; }

reportar CIT-JuanPanico     -34.6037 -58.3816; sleep 30
reportar CIT-LuciaTranquila -34.6033 -58.3816; sleep 30
reportar U000042            -34.6037 -58.3810
```

El tablero se mira igual, desde la sesión del despachador.

## Al terminar

Son emergencias reales en producción y sus eventos salen al bus. Cada ciudadano cancela la suya
desde "Mis alertas", o por API con
`PATCH /api/emergencies/{id}/cancel` y el token de ese ciudadano.
