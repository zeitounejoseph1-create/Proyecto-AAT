# MesaLista · Entrega de etapa 1

12 de noviembre de 2026. Base revisada: `main`, commit `2a97adf`.

## Lo que ya existía

- Página con buscador, perfiles/menús, ubicación y editor local de restaurantes y horarios.
- API Vercel con RPC Supabase para catálogo, disponibilidad, creación y comprobantes.
- Esquema de restaurantes, mesas, reservas, bloqueos, suscripciones, pagos, puntos y reseñas. Sólo reservas tenía integración de servidor.
- Restricción de reservas solapadas y un primer mecanismo de idempotencia.
- Scripts acumulados redefinían funciones. Asistencia, cancelación, reseñas y activación modificaban únicamente el navegador.

Se inspeccionó la página publicada como referencia. Mostraba ejemplos con calificaciones y precios predefinidos; eso no demuestra reservas operativas. No se crearon reservas ni se cambió producción.

## Cambios

| Área | Resultado |
| --- | --- |
| Cupos | Duración, horarios nocturnos, zonas y DST, capacidad, bloqueos, publicación y suscripción |
| Concurrencia | Lock por restaurante y exclusión de intervalos; sólo un cliente obtiene la última mesa |
| Reintentos | Token, clave y datos iguales devuelven la misma reserva; cambios se rechazan incluso entre restaurantes |
| Cancelación | Servidor con comprobante privado, estado guardado y cupo liberado; rechaza reservas iniciadas |
| Integridad | Mesas del mismo restaurante, asistencia mantiene ocupación, bloqueos no invaden reservas |
| Privacidad | Invitados no sobrescriben perfiles; snapshots de contacto y zona; respuestas públicas filtradas |
| Seguridad | RLS también en bases antiguas, secretos sólo servidor, validación/JSON limitado, timeout y errores sin PII |
| Navegador | Descarta consultas atrasadas; recuperación tras recarga; comprobantes por clave individual entre pestañas |
| Interfaz | Scripts duplicados consolidados, DOM/textContent y CSP, política aceptada y ejemplos identificados |
| Pendientes visibles | Sin puntos/asistencia manipulables, reseñas inventadas, activación falsa ni precios definitivos; garantía con tarjeta bloqueada |

Se conservan identidad visual, buscador, menús, ubicación y configuración de ejemplos. El rediseño completo corresponde a etapa 2.

## Verificación

- **API:** 20 casos de validación, claves nuevas/legadas, contratos, errores, timeout y cancelación.
- **PostgreSQL real 18.6:** migración repetible y reparación RLS antigua; permisos por rol; capacidad, privacidad y DST; carreras entre conexiones y cancelación tras esperar locks.
- **Chrome:** política requerida, creación/recarga, cancelación y cupo, respuesta perdida/retry, consultas atrasadas, comprobantes entre pestañas y móvil de 390 px.
- Datos desechables locales. El puente HTTP ejecuta SQL real; falta validar el gateway Supabase y despliegue Vercel.

## Archivos

- `api/reservations.js`, `reservation-api.test.cjs`.
- `db/schema.sql`, `db/reservation_core.sql`, `db/reservation_core.test.sql`, `db/RESERVATION_SETUP.md`.
- `index.html`, `assets/app.js`, `assets/styles.css`.
- `scripts/dev-server.cjs`, `scripts/test-database.cjs`, `scripts/verify-database.cjs`, `tests/browser.test.cjs`.
- `package.json`, `pnpm-lock.yaml`, `.github/workflows/test.yml`.
- `.env.example`, `.vercelignore`, `vercel.json`, `README.md`, este informe.

## Pendientes

Etapa 1 tiene implementación y pruebas locales; falta validarla en entorno real. Configurar variables privadas en Vercel y migrar Supabase de desarrollo siguiendo la guía. Corregir inconsistencias históricas si la migración las detecta. Antes de tráfico público, configurar límites compartidos y protección contra reservas automatizadas.

Siguen pendientes autenticación del panel, permisos de empleados, edición de reservas y combinación de mesas. Cuentas, reseñas verificadas, QR, espera, grupos compartidos, recompensas, facturación, Flash y notificaciones corresponden a siguientes etapas. Grupos actuales: 1 a 30 según una mesa individual.

La siguiente etapa de diseño puede renovar portada, tarjetas y navegación sobre esta base. Esta entrega se propone en rama de revisión; no se fusiona ni se publica en producción y no activa cobros.
