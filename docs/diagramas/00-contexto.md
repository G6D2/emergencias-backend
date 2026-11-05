# Contexto (C4 nivel 1)

Para qué sirve: ubicar el módulo **Emergencias y Seguridad** dentro de CityPass+ y de la
cátedra: quién lo usa, qué otros sistemas propios y externos lo rodean, y cuáles de esas
conexiones ya funcionan hoy contra cuáles todavía son intención de integración. Es el nivel más
alto de C4 (contexto): no muestra contenedores ni componentes internos — eso está en
`03-arquitectura.md`.

```mermaid
flowchart TB
    ciudadano(["Ciudadano"]):::persona
    dispatcher(["Operador / Dispatcher"]):::persona
    oficial(["Oficial<br/>(solo por API, sin vista en el front)"]):::persona

    core["Emergencias y Seguridad<br/>(CityPass+)"]:::sistemaPropio

    geo["Geocodificación<br/>BigDataCloud / Nominatim"]:::externoEnUso
    bus["Bus de eventos / gateway<br/>Grupo 1"]:::externoEnUso
    espacios["Espacios Públicos<br/>(publica eventos comunitarios)"]:::externoEnUso
    login["Login Federado<br/>Grupo 2"]:::externoEnUso
    analitica["Analítica, Reclamos, Movilidad<br/>(consumidores previstos)"]:::externoPrevisto

    ciudadano -->|"dispara SOS, cancela"| core
    dispatcher -->|"valida, despacha, cierra"| core
    oficial -->|"en camino, en el lugar, resuelta"| core

    core -->|"geocodifica dirección (BFF)"| geo
    espacios -->|"EventoComunitarioPublicado / EventoCancelado"| bus
    bus -->|"consume (cobertura preventiva)"| core
    core -.->|"publicaría sus eventos (outbox apagado)"| bus
    bus -.->|"EmergenciaCreada / Actualizada"| analitica
    core -->|"token de servicio para el bus"| login
    core -.->|"validaría JWT de usuarios (AUTH_MODE=idp)"| login

    classDef persona fill:#e7f5ff,stroke:#1971c2,color:#0b3d91,stroke-width:1.5px;
    classDef sistemaPropio fill:#d3f9d8,stroke:#2f9e44,color:#1b4332,stroke-width:2px;
    classDef externoEnUso fill:#e5dbff,stroke:#7048e8,color:#3c1361,stroke-width:1.5px;
    classDef externoPrevisto fill:#f1f3f5,stroke:#adb5bd,color:#495057,stroke-width:1px,stroke-dasharray: 4 3;
```

## Leyenda

| Estilo | Significado |
|---|---|
| Azul sólido (persona) | Actor con grupo propio en `src/auth/groups.js` (`citizen`, `dispatcher`, `officer`) |
| Verde sólido (sistema propio) | El sistema que este repo (y `Frontend`) implementan: Emergencias y Seguridad |
| Violeta sólido (sistema externo en uso) | Sistema de otro proveedor o grupo, ya integrado y llamado hoy en producción |
| Gris punteado (sistema externo) | Sistema de otro grupo previsto, sin tráfico real hoy |
| Línea punteada | Integración programada pero apagada o prevista |

## Qué está conectado hoy y qué no

- **Geocodificación inversa** (BigDataCloud, con Nominatim de respaldo) desde el BFF al reportar
  una emergencia.
- **Consumo del bus del Grupo 1**: con `KAFKA_CONSUMER_ENABLED=true`, el backend escucha
  `EventoComunitarioPublicado` y `EventoCancelado` de Espacios Públicos y programa o cancela una
  cobertura preventiva (emergencia `PREVENTIVA`). Se conecta con SASL/OAUTHBEARER y SSL, y lee
  Avro con el schema registry del gateway.
- **Login Federado (Grupo 2)**, solo para el token client-credentials que pide el bus
  (`EDA_OAUTH_*`).
- **Publicación al bus**: apagada. El outbox guarda los eventos (`OUTBOX_PUBLISHER_ENABLED=false`),
  así que Analítica, Reclamos y Movilidad no reciben nada todavía.
- **Login de usuarios**: local (`AUTH_MODE=local`, JWT propio con el mismo contrato de claims
  que el IdP real). Validar contra el IdP del Grupo 2 (`AUTH_MODE=idp`) es solo configuración.
- **Oficial**: el grupo `officer` existe y los endpoints `en-route`, `on-scene` y `resolve`
  funcionan, pero el `Frontend` no tiene una vista de oficial; esos pasos se hacen por API
  (Swagger o Postman).

## Fuente en el código

- `src/auth/groups.js` (`citizen`, `dispatcher`, `officer`), `src/auth/dev-login-policy.js`
  (subs demo, incluidos `of-001` y `of-002`)
- `src/auth/setup.js`, `src/auth/config.js` (`AUTH_MODE=local` hoy, `AUTH_MODE=idp` previsto)
- `src/services/kafka.service.js`, `src/services/eda-auth-client.js`,
  `src/services/outbox-publisher.js`, `src/listeners/`, `render.yaml`
- `Frontend/app/api/geocode/route.js`, `Frontend/lib/geocode-server.js` (BigDataCloud primario,
  Nominatim de respaldo)
- Documento de producto: `Grupo 6 - Emergencias - Casos de Uso.md` (CU-03 recibir emergencia
  de otro módulo, CU-07/CU-08 rol oficial)
