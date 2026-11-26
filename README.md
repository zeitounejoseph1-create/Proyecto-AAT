# MesaLista

Reservas para restaurantes en México. Continúa la aplicación existente con HTML, CSS, JavaScript, funciones Node en Vercel y PostgreSQL/Supabase. El código conserva un filtro legado de suscripción activa. El plan solicitado el 17 de noviembre contempla alta gratuita y bonos opcionales con comisión del 15% sobre el presupuesto del bono redimido; esa adaptación no se implementa durante este diagnóstico.

## Desarrollo

Node 24.x y pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

Abrir `http://127.0.0.1:3000`. Sin credenciales conserva los perfiles guardados o, si no hay ninguno, muestra ejemplos identificados; no confirma mesas. Para Supabase de desarrollo configurar `.env.local` desde `.env.example` y seguir [la guía](db/RESERVATION_SETUP.md).

El [diagnóstico del 17 de noviembre](docs/DIAGNOSTICO_2026-11-17.md) explica las variables, el catálogo filtrado, los permisos de Vercel y lo que falta verificar. `pnpm diagnose:local` y `pnpm diagnose:public` hacen únicamente consultas GET y no imprimen secretos. El primero devuelve código de salida 2 si el servicio local no está configurado.

La [verificación real en Supabase de desarrollo](docs/INTEGRACION_DESARROLLO_2026-11-17.md) completó disponibilidad, reserva guardada, comprobante, cancelación y cupo liberado, incluido el rechazo de solicitudes duplicadas para la misma mesa y horario. Las 45 pruebas locales pasaron nuevamente. El cierre de Etapa 1 sigue pendiente de Vercel y del diagnóstico del catálogo publicado; no se desplegó esta rama.

## Estructura

| Archivo | Responsabilidad |
| --- | --- |
| `index.html`, `assets/` | Página existente, estilos y flujos del navegador |
| `api/reservations.js` | Validación, consulta, creación y cancelación en servidor |
| `db/` | Esquema, migración de seguridad y pruebas SQL |
| `scripts/` | Servidor local y PostgreSQL desechable para pruebas |
| `tests/`, `reservation-api.test.cjs` | Pruebas API y recorrido de navegador |
| `vercel.json` | Cabeceras y CSP sin scripts inline |

## Verificación

```sh
pnpm exec playwright install chromium
pnpm test:all
```

GitHub Actions ejecuta API, PostgreSQL y navegador con datos temporales, sin secretos Supabase. Localmente también admite Chrome instalado con `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

## Instalación de Vercel

`vercel.json` utiliza `pnpm install --prod --frozen-lockfile` para la instalación general. La función nativa de `/api` puede ejecutar su propio instalador: `api/package.json` y `api/pnpm-lock.yaml` delimitan por eso un paquete independiente sin dependencias externas. La API usa módulos de Node y HTTP hacia Supabase; `embedded-postgres`, `pg` y `playwright` se conservan como herramientas de pruebas en las `devDependencies` de la raíz. No se autorizaron scripts adicionales de dependencias ni se desactivó la política estricta de pnpm.

`pnpm verify:production` verifica en un directorio limpio la instalación general y la instalación predeterminada del paquete de la API, conserva ambos lockfiles y ejecuta los 20 casos de la API sin herramientas de pruebas instaladas. CI ejecuta esta comprobación además de las 45 pruebas existentes. La [corrección para el instalador nativo](docs/CORRECCION_API_NATIVA_VERCEL_2026-11-18.md) explica por qué el comando general no bastaba.

La [entrega de etapa 1](docs/ETAPA_1.md) detalla mejoras y pendientes. El editor de ejemplos sigue siendo local; cuentas, panel autorizado, pagos, recompensas y notificaciones no están activados.



## Decisiones de diseño vs. sugerencias del IS

### 1. Seguridad de las reservaciones

- Propuesta del IS:Codex recomendó eliminar la recopilación insegura de tarjetas.
- Mi decisión:Aceptè la recomendación de Codex.
- Motivo:Prefiero proteger los datos bancarios de los clientes antes que implementar un sistema de penalizaciones que no sea seguro.
- Evidencia: commit 2a97adf.

### 2. Corrección de búsqueda y horarios

- Propuesta del IS:Codex propuso eliminar el ejemplo incorrecto de Trattoria Roma y mostrar únicamente los horarios disponibles consultados en el servidor.
- Mi decisión:Pedí corregir el error que encontré al probar mi aplicación y después comprobé que la búsqueda funcionara.
- Motivo:Quiero que los clientes puedan encontrar restaurantes y horarios disponibles sin recibir información incorrecta ni tener problemas al reservar.
- Evidencia: commit 86205a2.

## Verificación final del producto

Fecha: 26 de noviembre de 2026.

Pruebas manuales:
- Búsqueda y disponibilidad para 2 personas a la 1:00 p.m.
- Consulta del menú con 4 productos, precios y horarios.

Pruebas automatizadas reportadas por Codex:
- 80/80 pruebas locales aprobadas.
- 51/51 pruebas de GitHub CI aprobadas.
- 18 comprobaciones en producción aprobadas.

Las pruebas manuales se realizaron con el restaurante
de demostración, sin confirmar una reservación.

## Aplicación desplegada

https://proyecto-aat.vercel.app/
