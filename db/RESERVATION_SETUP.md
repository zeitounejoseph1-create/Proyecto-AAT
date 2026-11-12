# Configuración de reservas persistentes

## Estado de esta entrega

El flujo navegador → API → PostgreSQL se verificó con datos desechables locales. No se aplicó esta migración al proyecto Supabase real ni se publicó en Vercel. La salud `configured: true` sólo indica variables válidas; el catálogo y las operaciones comprueban los RPC.

La interfaz confirma únicamente respuestas verificadas del servidor. Sin servicio muestra ejemplos identificados y desactiva reservas reales. `localStorage` conserva comprobantes privados, solicitudes pendientes y ejemplos; no determina cupos, asistencia, puntos ni confirmaciones.

## Base de datos

Primero probar en un proyecto Supabase de desarrollo y respaldar la base existente.

- **Base nueva:** ejecutar `db/schema.sql` una sola vez y después `db/reservation_core.sql` en el SQL Editor o con una conexión administrativa.
- **Base existente con el esquema anterior:** ejecutar sólo `db/reservation_core.sql`. La migración es transaccional y repetible.
- Requiere PostgreSQL, extensiones `pgcrypto`, `btree_gist` y los roles Supabase `anon`, `authenticated`, `service_role`.
- Activa RLS, revoca acceso público a tablas y reserva RPC al servidor. También revoca `CREATE` en `public` a visitantes y cuentas normales.
- Si encuentra mesas de otro restaurante, horas inválidas o reservas asistidas solapadas, falla con rollback. Corregir los datos expresamente antes de volver a aplicar; no borrar datos para forzar la migración.
- No puede reconstruir contactos o zonas históricas ya sobrescritos. Conserva el mejor snapshot disponible; las nuevas reservas guardan el suyo.

El panel autorizado todavía está pendiente. No crear políticas amplias para `authenticated` como atajo: cada cuenta necesita membresía explícita del restaurante para administrar sus datos.

## Variables privadas del servidor

Configurar en Preview de Vercel y, después de validar, en Production:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-private-server-key
```

`sb_secret_...` va sólo en `apikey` al llamar Supabase. El nombre legado `SUPABASE_SERVICE_ROLE_KEY` sigue compatible y sus JWT usan también Bearer. Nunca usar nombres públicos `NEXT_PUBLIC_*`, ni pegar secretos en GitHub, HTML o un chat. [Referencia oficial de Supabase](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys).

Localmente copiar `.env.example` a `.env.local`, completar fuera de Git y ejecutar `pnpm dev`. HTTP se admite únicamente para localhost, útil en pruebas aisladas.

## Datos reales del restaurante

Crear mediante una conexión administrativa:

- Propietario en `users` y restaurante en `restaurants` con zona IANA válida, duración de 30 a 480 minutos y datos confirmados por el negocio.
- Horarios semanales en `restaurant_hours` y mesas activas en `dining_tables`, cada una con capacidad de 1 a 30.
- Suscripción `active` cuyo `renews_at` siga vigente o sea nulo. Su estado se comprueba, pero la facturación recurrente aún no está integrada. El operador configura el precio.
- Menú, precios e imágenes reales; `approved = true` y `published = true` cuando corresponda.

`requires_card_guarantee = true` excluye al restaurante de las reservas online hasta integrar un proveedor seguro. No se capturan tarjetas ni se cobran cargos; no eludir este requisito sin acuerdo del restaurante.

Los bloqueos de `availability_blocks` pueden cubrir una mesa o todo el restaurante. Rechazan intervalos incompatibles con reservas activas; primero se deben resolver esas reservas.

## Contrato HTTP

| Operación | Solicitud |
| --- | --- |
| Salud | `GET /api/reservations` |
| Catálogo | `GET /api/reservations?mode=restaurants` |
| Horarios | `GET /api/reservations?restaurant_id=UUID&date=YYYY-MM-DD&party_size=4` |
| Comprobante | `GET /api/reservations` con `Authorization: Bearer TOKEN_PRIVADO` |
| Crear | `POST` JSON: `restaurant_id`, `date`, `time`, `party_size`, `name`, `email`, `access_token`, `idempotency_key` |
| Cancelar | `POST` JSON: `{ "action": "cancel", "access_token": "TOKEN_PRIVADO" }` |

Fecha/hora: zona del restaurante, franjas de media hora, hasta 365 días adelante. La capacidad depende de una mesa individual: todavía no se juntan mesas. Cancelar requiere comprobante privado y que la reserva no haya empezado; repetir es seguro. Las políticas se muestran y se aceptan, pero plazos o cargos personalizados aún no se ejecutan automáticamente.

Creación exige token aleatorio y clave de idempotencia estables. El navegador guarda cada solicitud antes de POST bajo una clave individual; después guarda cada comprobante igual, evitando sobrescrituras entre pestañas. Timeout/502/504 deja el resultado **sin verificar**: reintentar exactamente el mismo payload y claves. Nunca inventar una reserva local ni cambiar la clave para resolver una respuesta perdida.

Se usa un header privado para evitar tokens en URLs y logs. `?token=` queda sólo por compatibilidad anterior; no generar nuevos enlaces así. Los comprobantes permiten consultar/cancelar: tratarlos como secretos. Borrar almacenamiento puede perder acceso. Cuentas, recuperación por correo y notificaciones quedan pendientes.

Las respuestas de invitado no devuelven correo, nombre de contacto, hashes ni datos internos. Usar un correo en una reserva no acredita propiedad de la cuenta correspondiente.

## Pruebas

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec playwright install chromium
pnpm test
pnpm test:database
pnpm test:browser
```

Las pruebas de base y navegador crean PostgreSQL real en un directorio temporal, replican roles Supabase y destruyen la base al terminar. No usan credenciales externas. El puente HTTP reproduce RPC, pero falta comprobar el gateway real Supabase.

Las carreras usan conexiones distintas esperando locks reales: última mesa, retry idéntico, clave entre restaurantes, bloqueo contra reserva y cancelación que vence mientras espera. Navegador verifica creación, política, cancelación, respuestas perdidas, búsquedas atrasadas, varias pestañas y móvil.

## Antes de abrir reservas públicas

- Aplicar y probar la migración en Supabase de desarrollo, configurar Preview y completar reserva/cancelación con el gateway real.
- Configurar y verificar límites compartidos en [Vercel Firewall](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting): como mínimo `/api/reservations`, POST, agrupación por IP y respuesta 429.
- Añadir protección contra reservas automatizadas: identidad/contacto verificado o desafío validado por nuestro servidor. RLS e idempotencia no impiden ocupar cupos con correos distintos. CAPTCHA de Supabase Auth no protege por sí solo este endpoint.
- Completar autenticación y permisos del restaurante antes de habilitar su panel.
- Validar datos/políticas reales. Edición de reservas, combinación de mesas, pagos, puntos y notificaciones siguen pendientes.

Mantener en revisión hasta completar estos requisitos. No activar cobros reales ni probar con producción.
