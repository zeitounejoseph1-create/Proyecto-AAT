# Activar reservaciones persistentes

La página conserva el modo de demostración local. La ruta de servidor solo activa reservaciones persistentes cuando está desplegada en Vercel y puede conectarse a Supabase PostgreSQL.

## Base de datos

- Para una base nueva, ejecuta `db/schema.sql` y luego `db/reservation_core.sql`.
- Para la base existente creada desde el esquema anterior, ejecuta `db/reservation_core.sql` como migración.
- Para comprobar horarios, capacidad, duplicados e idempotencia en una base de pruebas desechable, ejecuta `db/reservation_core.test.sql`. El script hace `ROLLBACK` al terminar.
- Marca los restaurantes como `approved = true` y `published = true`, configura sus filas en `restaurant_hours`, registra mesas y activa una fila de `subscriptions` antes de ofrecerlos.

## Variables del servidor

En la configuración de entorno de Vercel agrega:

- `SUPABASE_URL`: URL del proyecto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: clave de servicio privada de Supabase. Guárdala solo como variable de servidor; nunca la agregues a `index.html` ni a una variable pública `NEXT_PUBLIC_*`.

La ruta `/api/reservations` informa que está sin configurar hasta que ambas variables existan. El cliente entonces continúa en modo local, y sus mensajes identifican las reservas como locales. Cuando la ruta confirma que el backend está configurado, el formulario carga restaurantes aprobados con suscripción activa y la base de datos valida de nuevo horario, capacidad y conflictos al confirmar.

## Pruebas

- Las pruebas de la ruta sin conexión externa: `/Users/josephzeitoune/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test reservation-api.test.cjs`.
- La prueba PostgreSQL requiere una base de pruebas con el esquema aplicado; no ejecutes fixtures de prueba sobre datos de producción.
- Una prueba de concurrencia real requiere dos sesiones PostgreSQL independientes que intenten tomar simultáneamente la misma mesa. La exclusión de rangos de `reservations` es la última protección contra solapamientos.

No se ha realizado ningún despliegue ni se ha ejecutado una migración contra una base externa.
