# MesaLista — integración real en desarrollo

**Actualización posterior:** los logs de Vercel permitieron identificar y corregir el bloqueo de instalación. El empaquetado oficial pasó localmente; la Preview remota sigue pendiente de autorización. Ver [la corrección de instalación](CORRECCION_INSTALACION_VERCEL_2026-11-17.md). Este informe conserva la evidencia de Supabase y el estado de Vercel durante esa prueba.

17 de noviembre de 2026. Solo Etapa 1, rama `codex/etapa-1-diagnostico-20261117`. El bloque de reservas contra Supabase de desarrollo está verificado; el cierre de la etapa continúa pendiente de Vercel y de los diagnósticos de la publicación descritos más abajo.

## Entorno y alcance

- Proyecto exclusivo: **MesaLista-Desarrollo**, referencia `udwanmsriljzgkeqbwwj`.
- Restaurante ficticio autorizado: `f8ed7292-3524-4755-968f-8c17e17bf571`, **MesaLista QA Desarrollo 0aba56de**.
- Una mesa activa de cuatro personas, siete horarios de 12:00 a 22:00, un plato de prueba, duración de reserva de 90 minutos y suscripción de importe cero sin proveedor de pagos.
- `.env.local` existente, excluido de Git y con permisos privados. Se comparó su destino con una lista permitida de un único origen HTTPS; el gateway confirmó la misma referencia de proyecto. Los secretos no se imprimieron ni llegaron al navegador.
- Las migraciones y la carga administrativa de datos ficticios fueron ejecutadas por el usuario en el SQL Editor. La consulta de metadatos devolvió `installation_ok: true`, sin incidencias: 11 tablas, 94 columnas, 55 restricciones, 8 disparadores, 12 funciones y RLS en todas las tablas.
- La API real anunció las 11 tablas, las 94 columnas y los cinco RPC principales; el catálogo devolvió el restaurante ficticio.

Se ejecutó la aplicación local mediante `createAppServer`, en un puerto temporal, conectada al gateway real de Supabase. El navegador de prueba fue Chrome sin interfaz. Las llamadas a Supabase se realizaron desde el servidor, con destino fijo y sin seguir redirecciones. No se utilizó el servidor anterior de puerto 3000 para acreditar estos resultados.

## Flujo verificado

Fecha de la reserva: **19 de noviembre de 2026**, zona **America/Mexico_City**. Primer horario: **13:00**, cuatro personas.

| Paso | Resultado observado |
| --- | --- |
| Disponibilidad real | HTTP 200, 18 horarios disponibles antes de reservar; 13:00 ofrecía la mesa de prueba. |
| Capacidad | Cinco personas no obtuvieron horarios para la mesa de cuatro. |
| Creación | HTTP 201, estado `confirmed`. |
| Persistencia | Una llamada independiente a `reservation_for_guest` leyó la misma reserva guardada, con el mismo restaurante y mesa. |
| Cupo ocupado | El horario 13:00 desapareció de la disponibilidad. |
| Reintento idéntico | Devolvió el mismo identificador, sin una nueva reserva. |
| Segunda solicitud independiente | Otra clave y otro token para el mismo restaurante, mesa y horario recibieron HTTP 409 `RESERVATION_CONFLICT`; el token rechazado no tenía ninguna reserva guardada. |
| Comprobante privado | HTTP 200, identificador y estado correctos; sin contacto, hashes ni campos internos. Un token diferente recibió 404. |
| Cancelación | HTTP 200 y estado `cancelled`, confirmado mediante otra lectura del RPC. |
| Comprobante posterior | Reflejó el estado cancelado. |
| Cupo liberado | La misma mesa volvió a ofrecer el horario 13:00. |
| Repetir cancelación | Devolvió de forma segura el estado cancelado. |

Las comprobaciones de persistencia usaron funciones SQL que leen la base en solicitudes independientes. Se mantuvo el acceso a las tablas limitado: no se concedieron permisos directos adicionales a `service_role`, `anon` ni `authenticated` para hacer estas pruebas.

## Dos solicitudes simultáneas

Se enviaron en paralelo **dos solicitudes distintas** para las **16:00**, con claves de idempotencia y tokens independientes, cuatro personas y una única mesa disponible.

- Una solicitud respondió **201** y guardó una reserva confirmada.
- La otra respondió **409** y su token no recuperó ninguna reserva.
- El RPC confirmó que la ganadora ocupaba la mesa de prueba y el horario dejó de ofrecerse.
- Se canceló la ganadora; su estado quedó guardado como cancelado y las 16:00 volvieron a estar disponibles.

Esto verifica la exclusión en el caso probado contra el gateway real. Las pruebas locales complementan el resultado con conexiones simultáneas, solapamientos, bloqueos y reintentos.

## Recorrido del navegador

Chrome consultó el restaurante real de prueba mediante la API local y mostró su menú. Se eligieron fecha, personas y horario, se aceptó la política y se confirmó una nueva reserva ficticia. La reserva se recuperó después de recargar la página. La cancelación desde la interfaz quedó guardada en Supabase y liberó el mismo horario.

No se detectaron errores JavaScript, respuestas fallidas de la API durante ese recorrido, peticiones del navegador a Supabase ni envío de la clave del servidor al navegador. A 390 píxeles no hubo desbordamiento horizontal; no apareció un formulario de tarjeta.

Las fotografías externas se omitieron en el navegador automatizado mediante una respuesta vacía. Este recorrido no acredita la disponibilidad de esas imágenes externas ni una revisión visual del rediseño. No se cambió el diseño de la aplicación.

## Datos que quedaron en desarrollo

Se conservaron el restaurante y sus datos ficticios. Las tres reservas creadas por estas pruebas quedaron **canceladas** y sus cupos liberados; no se borraron filas:

| Reserva ficticia | Prueba | Estado final |
| --- | --- | --- |
| `e5d9b347-7e37-441e-9287-cbb278ab81ad` | API: reserva, comprobante y cancelación | `cancelled` |
| `ea7d7bf2-e410-48cd-9dac-91e02ae2f87b` | Ganadora de dos solicitudes simultáneas | `cancelled` |
| `cf1ae089-1620-4ff5-b056-6f2c80ed5618` | Navegador, recarga y cancelación | `cancelled` |

Los contactos fueron ficticios con dominio `example.test`. No se enviaron notificaciones ni se realizaron cobros. Las credenciales de Supabase y los tokens privados de los comprobantes no forman parte de este documento ni del commit.

## Pruebas locales

Se ejecutó nuevamente la batería existente: **45 aprobadas, 0 fallidas, 0 omitidas**. El total de Node incluye 42 casos y tres contenedores.

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test:all
```

Incluye 20 casos de API, dos de diagnóstico, siete de PostgreSQL/concurrencia/seguridad, dos de catálogo y 11 de navegador. Estas pruebas crean sus propias bases temporales, sin credenciales externas. Son evidencia separada de las pruebas remotas anteriores.

## Pendientes para cerrar Etapa 1

**Vercel sigue bloqueado.** La lectura actual de `proyecto-aat`, en `joseph-3fa9` (`team_gz9o8zCCMb5XQCvQ5yKhVPU0`), devolvió **403 `forbidden`** por falta de acceso de la conexión al equipo. Las lecturas anteriores de logs tenían el mismo rechazo y el intento de generar un enlace de autorización devolvió 404 `Team not found`.

1. Quien administra `joseph-3fa9` debe comprobar que la cuenta y la integración conectadas conservan acceso al equipo y a `proyecto-aat`.
2. En **Integrations → Manage → Access → Manage Access**, incluir ese proyecto. Revisar permisos de lectura de **Deployment**, **Project** y **Team**; Deployment incluye los logs de compilación. [Guía oficial de permisos](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference).
3. Leer los **Build Logs** del despliegue fallido `dpl_761tzPMS1rUi4oogDAYkHTTHu7wT`, identificar la causa concreta y corregir solo lo que acrediten los logs. El fallo de compilación sigue sin causa verificada. [Abrir despliegue](https://vercel.com/joseph-3fa9/proyecto-aat/761tzPMS1rUi4oogDAYkHTTHu7wT).
4. Comprobar la configuración de Preview y que sus variables apunten a desarrollo. Validar esa Preview cuando el usuario autorice publicarla. No hace falta desactivar Deployment Protection para resolver la lectura de la API de administración.

El catálogo de desarrollo con un restaurante ficticio no explica el total de restaurantes de producción ni qué filtro excluye a los demás en la API publicada. El diagnóstico privado de ese catálogo continúa pendiente según `DIAGNOSTICO_2026-11-17.md`; requiere los conteos de solo lectura del proyecto correspondiente. No se accedió a producción en esta verificación.

El panel privado y el rediseño siguen aislados en el respaldo. No se inició Etapa 2. No se hicieron push, despliegues, cambios a producción ni modificaciones de permisos remotos. Esta actualización registra evidencia; no cambia el código funcional ni las migraciones.
