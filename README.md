# MesaLista

Reservas para restaurantes en México. Continúa la aplicación existente con HTML, CSS, JavaScript, funciones Node en Vercel y PostgreSQL/Supabase. El código conserva un filtro legado de suscripción activa. El plan solicitado el 17 de noviembre contempla alta gratuita y bonos opcionales con comisión del 15% sobre el presupuesto del bono redimido; esa adaptación no se implementa durante este diagnóstico.

## Desarrollo

Node 22 o posterior y pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

Abrir `http://127.0.0.1:3000`. Sin credenciales conserva los perfiles guardados o, si no hay ninguno, muestra ejemplos identificados; no confirma mesas. Para Supabase de desarrollo configurar `.env.local` desde `.env.example` y seguir [la guía](db/RESERVATION_SETUP.md).

El [diagnóstico del 17 de noviembre](docs/DIAGNOSTICO_2026-11-17.md) explica las variables, el catálogo filtrado, los permisos de Vercel y lo que falta verificar. `pnpm diagnose:local` y `pnpm diagnose:public` hacen únicamente consultas GET y no imprimen secretos. El primero devuelve código de salida 2 si el servicio local no está configurado.

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

La [entrega de etapa 1](docs/ETAPA_1.md) detalla mejoras y pendientes. El editor de ejemplos sigue siendo local; cuentas, panel autorizado, pagos, recompensas y notificaciones no están activados.
