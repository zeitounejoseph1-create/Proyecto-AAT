# MesaLista — diagnóstico de Etapa 1

**Actualización posterior del mismo día:** se configuró e instaló MesaLista-Desarrollo y pasó el flujo real de reservas, cancelaciones y concurrencia, junto con las 45 pruebas locales. Ver [la evidencia actual](INTEGRACION_DESARROLLO_2026-11-17.md). El resto de este documento conserva el diagnóstico inicial y sus resultados históricos; los bloqueos de configuración de desarrollo descritos abajo ya quedaron resueltos. Vercel y los conteos privados del catálogo publicado siguen pendientes.

**Actualización de Vercel:** los logs aportados posteriormente identificaron `ERR_PNPM_IGNORED_BUILDS` por una herramienta de pruebas. La instalación se corrigió y el empaquetado oficial pasó localmente; falta validarlo en una Preview autorizada. Ver [la corrección y sus verificaciones](CORRECCION_INSTALACION_VERCEL_2026-11-17.md). Las referencias posteriores a causa desconocida describen el diagnóstico inicial.

17 de noviembre de 2026. Trabajo local en `codex/etapa-1-diagnostico-20261117`, sobre `636b6ef`. No se inició Etapa 2, no se hizo push ni despliegue y no se modificó Supabase real.

El respaldo `backup/mesalista-trabajo-en-curso-20261117` permanece en `8a497bf5533c17ea2bdbbb5e7234579d2534d61c`. Contiene el trabajo de panel y rediseño separado anteriormente.

## Qué funciona

- **En pruebas locales completas:** búsqueda por nombre con sugerencias y sin distinguir acentos, filtros de cocina/precio/fecha/personas/hora, menú, fotografía, precios, horarios y ubicación cercana con permiso del navegador.
- **Reservas con PostgreSQL real desechable:** creación, comprobante tras recargar, cancelación y liberación de mesa. Una respuesta perdida no se presenta como confirmación; el reintento conserva las claves y no duplica la reserva.
- **Seguridad local:** RLS y permisos por rol, datos privados fuera del catálogo, validación de solicitudes, última mesa ante clientes simultáneos y rechazo de tarjetas sin proveedor seguro. No hay formulario de tarjeta.
- **Sitio público, sólo lectura:** página HTTP 200, API configurada, catálogo HTTP 200 con **1 restaurante elegible**. Para el 18/11/2026, la disponibilidad devuelve 16 horarios para 2 personas y 0 para 20. No se hicieron reservas reales de prueba.

La página publicada todavía carga el JavaScript inline anterior; la rama local usa `assets/app.js`. Lo publicado no sirve para validar los últimos cambios locales.

## Por qué aparece un solo restaurante

La API no tiene un límite de un restaurante ni paginación que recorte a uno. Llama a `list_bookable_restaurants` y devuelve su catálogo público.

| Condición | SQL de `main` | SQL de esta rama |
| --- | --- | --- |
| Restaurante aprobado y publicado | Obligatoria | Obligatoria |
| Existe suscripción `active`, sin vencimiento o vigente | Obligatoria | Obligatoria |
| No exige garantía con tarjeta | No forma parte de ese filtro | Obligatoria |
| Horarios, mesas, bloqueos y reservas | Afectan disponibilidad | Afectan disponibilidad |

**No se pudo comprobar el total privado de restaurantes ni la definición SQL instalada en Supabase.** Un restaurante devuelto no demuestra que sólo haya uno guardado, ni identifica cuál filtro excluye a los demás. Tampoco se pudo comparar el proyecto de las variables de Vercel con el proyecto esperado. Cambiar filtros sin ese diagnóstico podría publicar restaurantes que aún no deben aparecer.

Para resolverlo sin cambiar datos: en el proyecto Supabase correcto, una persona con acceso al SQL Editor debe ejecutar **`db/diagnose_catalog.sql`**. Usa una transacción de sólo lectura y termina con rollback. Devuelve total, conteos por filtro, conteo del RPC instalado y metadatos de su definición; no devuelve contactos ni credenciales. Los conteos de exclusión se solapan y no deben sumarse. Compartir esos resultados, sin secretos, permite determinar si hay más registros y dónde se excluyen.

El SQL diagnóstico se probó con 8 restaurantes temporales: 3 pasan los filtros de `main`, 2 pasan los locales y el RPC instalado devuelve esos 2. Una prueba atravesando la API confirma que devuelve ambos; un restaurante sin mesas/horarios sigue en el catálogo, pero no tiene cupos.

El filtro de suscripción es legado y difiere del plan de alta gratuita y bonos opcionales solicitado el 17/11. Se documentó la diferencia; no se cambió el modelo comercial ni se habilitaron bonos en Etapa 1.

## Qué falla o sigue sin verificarse

| Área | Estado |
| --- | --- |
| Servicio local en `127.0.0.1:3000` | HTML 200; API 503 `SERVICE_UNAVAILABLE`: faltan las dos variables privadas. Es un bloqueo seguro, no una confirmación falsa. |
| Total y filtros reales de Supabase | Pendiente de ejecutar el diagnóstico de sólo lectura con acceso autorizado. |
| Reserva/cancelación contra Supabase de desarrollo | Pendiente de configurar un proyecto de desarrollo y verificar su gateway real. El puente local ejecuta PostgreSQL real, pero no reproduce todo Supabase. |
| Vista previa Vercel | GitHub registró fallo del despliegue; la lectura de logs sigue con 403 por acceso de la integración al equipo. Causa de compilación desconocida. |
| Panel privado/rediseño del respaldo | Aislados e incompletos; no integrados. La rama activa conserva la vista informativa y el editor de ejemplos, sin permisos para administrar restaurantes reales. |

## Qué se corrigió

1. Al fallar la conexión se conservan perfiles públicos previamente guardados, incluidos los UUID válidos del almacenamiento anterior. Se indican como **perfiles guardados con publicación y disponibilidad sin verificar**. No se guardan cupos en esa caché y no se ofrece confirmación offline.
2. Guardar un ejemplo local ya no sustituye esos perfiles guardados. Los datos anteriores no se borran.
3. Se corrigió la asociación incorrecta de un `else` en los horarios del perfil, para mostrar el aviso cuando faltan horarios.
4. Se prepararon `.env.example`, un diagnóstico GET sin secretos, SQL de sólo lectura y pruebas de regresión. No se modificaron API de reservas, esquema, migración principal, diseño, datos reales ni configuración de despliegue.

## Variables que debes configurar

Repositorio local: `/Users/josephzeitoune/Documents/Codex/2026-11-12/files-pasted-by-the-user-continuar/work/Proyecto-AAT`.

Crear **`.env.local` en esa raíz**, copiando `.env.example`. El archivo está excluido por Git. Completar únicamente en tu equipo con un proyecto **Supabase de desarrollo**:

| Variable | Valor y ubicación |
| --- | --- |
| `SUPABASE_URL` | Project URL del diálogo **Connect** del proyecto Supabase. Base HTTPS, sin `/rest/v1`, usuario ni contraseña. |
| `SUPABASE_SECRET_KEY` | Clave **Secret** de **Settings → API Keys**, del mismo proyecto. Empieza con `sb_secret_`. Sólo servidor. |
| `SUPABASE_SERVICE_ROLE_KEY` | Alternativa legada al secreto anterior si ya usas el JWT `service_role`. Elegir una opción; `SUPABASE_SECRET_KEY` tiene prioridad. |
| `PORT` | Opcional, `3000` por defecto. |

No hacen falta `DATABASE_URL`, una contraseña PostgreSQL, claves Stripe, una clave pública `anon`/`publishable` ni `SUPABASE_AUTH_KEY` para esta rama. La clave Auth pertenece al panel aún aislado. No poner secretos en HTML/JavaScript, nombres `NEXT_PUBLIC_*`/`VITE_*`, GitHub ni el chat. [Documentación oficial de claves Supabase](https://supabase.com/docs/guides/getting-started/api-keys).

Con Node 22 o posterior y pnpm 11.25.0, desde esa raíz:

```sh
cp .env.example .env.local
# Completar .env.local con tu editor antes de iniciar el servicio.
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

Reiniciar `pnpm dev` después de cambiar variables y abrir `http://127.0.0.1:3000/`. En otra terminal, `pnpm diagnose:local` consulta salud, catálogo y cupos. No imprime valores de entorno ni crea reservas. Si faltan variables devuelve salida 2; no indica un fallo de las pruebas.

La URL y clave no instalan el esquema ni los RPC: antes de probar con Supabase de desarrollo, revisar `db/RESERVATION_SETUP.md` según sea una base nueva o existente. No ejecutar `schema.sql` sobre una base existente. No se aplicó ninguna migración durante este trabajo.

Para una futura vista previa: las mismas variables van en **Vercel → proyecto `proyecto-aat` → Settings → Environment Variables → Preview**, apuntando a desarrollo. Development es opcional si se usa `vercel dev`. No sobrescribir Production ni redeplegar durante esta etapa sin autorización.

## Cómo resolver el permiso de Vercel

Despliegue fallido: `dpl_761tzPMS1rUi4oogDAYkHTTHu7wT`, asociado a `636b6ef`.

[Abrir el despliegue en Vercel](https://vercel.com/joseph-3fa9/proyecto-aat/761tzPMS1rUi4oogDAYkHTTHu7wT).

La integración devuelve **403 `forbidden`** al pedir sus eventos de compilación en el equipo `joseph-3fa9` (`team_gz9o8zCCMb5XQCvQ5yKhVPU0`). La lista de equipos accesibles está vacía; solicitar autorización por el ID o slug devolvió **404 Team not found**, sin enlace de consentimiento utilizable. Esto demuestra que la conexión actual no ve ese equipo; no demuestra por sí solo que falte acceso en tu sesión personal del navegador.

1. Entrar a Vercel con la cuenta que puede ver `joseph-3fa9` y `proyecto-aat`. Si el equipo no aparece, revisar la cuenta o pedir a quien administra el equipo acceso al proyecto y sus logs.
2. En ese equipo, **Integrations → integración conectada → Manage → Access → Manage Access**, incluir `proyecto-aat`. Comprobar **Permissions**: se necesita lectura de **Deployment** (incluye build logs), **Project** y **Team**. No se necesita permiso de despliegue/escritura para este diagnóstico. Si esos permisos no están disponibles, quien administra la integración debe autorizar los alcances que solicite o restablecer la conexión con la cuenta/equipo correcto. [Permisos y acceso oficiales](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference).
3. Abrir el despliegue anterior y revisar **Build Logs**. Como alternativa a la integración, compartir el primer error y unas líneas de contexto, ocultando valores secretos. Con ello se podrá identificar la causa real.

El repositorio tiene `vercel.json` con cabeceras, pero no define framework, instalación, compilación ni carpeta de salida; tampoco tiene script `build`. Es necesario revisar la configuración efectiva del proyecto y el primer error. No se inventó una causa ni se cambiaron comandos a ciegas. El código contiene página estática y funciones Node en `api/`; cualquier corrección de Preview deberá preservar ambas. El 403 de la API de Vercel es distinto de la protección de acceso a una URL de Preview: no se intentó evadir ninguno.

## Qué conviene recuperar del respaldo después

Comparación con la base común `636b6ef`: **11 archivos, +698/−98 líneas**. No se hizo merge ni cherry-pick del respaldo.

| Cambio aislado | Valor para una recuperación posterior | Validación necesaria |
| --- | --- | --- |
| `index.html`, `assets/styles.css` | Portada, navegación, tarjetas y presentación móvil más claras | Comparación visual y accesibilidad; preservar todos los flujos actuales |
| `assets/app.js` | Galería, enlace de mapa, selección de horarios por tarjeta y búsqueda por dirección/cocina | Manejo de resultados sin cupos y errores; no confundir explorar con disponibilidad |
| Editor local | Conservación de varias mesas y fotografías al editar | Pruebas para evitar pérdida de configuración |
| `api/admin.js`, `assets/admin.js`, `lib/server.js` | Sesión verificada con Supabase Auth, cookie HttpOnly y comprobación de propietario en servidor | Autenticación real, sesiones y rechazo de accesos entre restaurantes |
| `db/restaurant_admin.sql` | Menús, horarios, mesas, bloqueos y estados administrados mediante RPC privados | Revisión de permisos, concurrencia, datos existentes y rollback en desarrollo |
| `tests/admin.test.cjs` y soporte | Punto de partida para probar el panel | La ejecución previa del borrador falló; no constituye evidencia de un panel listo |

El borrador propone permisos de propietario; aún no demuestra un modelo completo de empleados/roles. Las pruebas fallidas del panel y el gateway Auth siguen pendientes. No conviene reactivar todo el respaldo en bloque.

## Pruebas y archivos

Resultado final: **45/45 pruebas Node aprobadas, 0 fallidas, 0 omitidas**. Son **42 casos**, más 3 contenedores contados por Node:

| Grupo | Casos |
| --- | ---: |
| API de reservas | 20 |
| Diagnóstico sin secretos y solicitudes sólo GET | 2 |
| PostgreSQL: integridad, RLS, migración y carreras | 7 |
| Catálogo y SQL diagnóstico | 2 |
| Chrome: búsqueda, datos, reservas, cancelaciones, fallos y móvil | 11 |

Para repetir la misma batería con Chrome instalado:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test:all
```

Se utilizó PostgreSQL 18.6 temporal, roles equivalentes a Supabase y un puente HTTP local. No se requieren secretos de producción. También pasó `git diff --check`. Las lecturas públicas pasaron; el diagnóstico local detectó la falta de configuración con salida 2. No hubo pruebas fallidas de la rama activa. Las validaciones privadas de Supabase y Vercel quedaron bloqueadas por configuración/permisos, no se cuentan como aprobadas.

Archivos modificados: `.env.example`, `assets/app.js`, `package.json`, `README.md`, `db/RESERVATION_SETUP.md`, `tests/browser.test.cjs`.

Archivos nuevos: `db/diagnose_catalog.sql`, `scripts/diagnose.cjs`, `tests/catalog.test.cjs`, `tests/diagnose.test.cjs`, `docs/DIAGNOSTICO_2026-11-17.md`.

## ¿Se puede cerrar Etapa 1?

**Todavía no.** El código local y las pruebas disponibles están listos, pero faltan tres verificaciones:

1. Obtener los conteos y la variante SQL instalada en el proyecto Supabase correcto.
2. Configurar Supabase de desarrollo y comprobar reserva → fila guardada → comprobante → cancelación → cupo liberado contra su gateway real.
3. Acceder al error de compilación de Vercel, corregir lo que indiquen los logs y validar Preview cuando se autorice publicar.

Hasta completar esos puntos se mantiene Etapa 1 abierta. El panel y el rediseño permanecen separados, y Etapa 2 no se inicia.
