# MesaLista — corrección de instalación en Vercel

17 de noviembre de 2026. Solo Etapa 1, rama `codex/etapa-1-diagnostico-20261117`. Respaldo conservado en `8a497bf5533c17ea2bdbbb5e7234579d2534d61c`.

## Causa identificada y reproducida

Los logs facilitados por el usuario corresponden al commit **`636b6ef`**, rama **`codex/etapa-1-reservas-seguras`**. El proceso falla durante `pnpm install`, antes de completar la compilación, con `ERR_PNPM_IGNORED_BUILDS` por el script de instalación de **`@embedded-postgres/linux-x64@18.6.0-beta.19`**.

`embedded-postgres`, `pg` y `playwright` ya estaban declarados como `devDependencies`. Vercel instala también las dependencias de desarrollo en su instalación general. PostgreSQL embebido incluye un paquete opcional por plataforma; al resolver Linux/x64 se selecciona el paquete señalado en los logs. pnpm 11 exige una decisión explícita para los scripts de dependencias y su política estricta rechaza un script sin revisar.

Se reprodujo en una copia limpia con **pnpm 11.25.0**:

```text
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @embedded-postgres/darwin-arm64@18.6.0-beta.19
```

En otra copia, seleccionando la resolución de dependencias **Linux/x64** mediante `supportedArchitectures`, se reprodujo el mensaje exacto del despliegue:

```text
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @embedded-postgres/linux-x64@18.6.0-beta.19
```

Ambas instalaciones terminaron con código 1. La segunda comprueba la selección y política del paquete Linux; se ejecutó desde macOS y no ejecutó binarios Linux.

## Revisión de archivos y corrección

| Archivo | Revisión o cambio |
| --- | --- |
| `package.json` | Conserva las tres herramientas de pruebas, sus versiones y todos los comandos de pruebas. Mantiene `packageManager: pnpm@11.25.0`; fija Node en `24.x`, versión usada por CI y las verificaciones, y añade `verify:production`. |
| `pnpm-lock.yaml` | Conservado sin cambios. Las versiones y sumas de integridad quedan bloqueadas; la instalación utiliza `--frozen-lockfile`. |
| `pnpm-workspace.yaml` | No existía en el repositorio y no se añadió. No se aprobaron scripts ni se redujo `strictDepBuilds`. Los archivos temporales usados para verificar políticas y arquitecturas están fuera del repositorio. |
| `vercel.json` | Añade `installCommand: pnpm install --prod --frozen-lockfile`. Conserva las cabeceras y la CSP existentes. |
| `.vercelignore` | Revisado y conservado sin cambios. Continúa excluyendo herramientas, SQL y documentación de la carga mediante CLI. |
| `scripts/verify-production-install.cjs` | Verifica una instalación de producción limpia con política estricta explícita, lockfile intacto y ausencia de las tres herramientas. Ejecuta después los 20 casos existentes de la API en ese directorio. |
| `.github/workflows/test.yml` | Conserva las 45 pruebas y añade `pnpm verify:production` al mismo trabajo Ubuntu/Node 24. El nuevo paso todavía no se ejecutó en GitHub porque no se hizo push. |
| `README.md` y documentación | Explican el nuevo comando, el requisito Node 24, los resultados y los límites de la verificación. |

La API de reservas utiliza `node:crypto`, `fetch` y otras capacidades incluidas en Node. Su conexión de producción es HTTP/RPC a Supabase; no necesita `pg`, PostgreSQL embebido ni Playwright. Las herramientas de pruebas siguen disponibles con la instalación local documentada (`pnpm install --frozen-lockfile --ignore-scripts`).

No se añadió un comando de compilación ficticio: la interfaz existente es HTML/CSS/JavaScript y Vercel empaqueta la función Node de `api/reservations.js`. No se modificaron la API, las migraciones, las reglas de reserva, los datos remotos ni el diseño.

## Verificación completada

Entorno disponible: **macOS ARM64**, **Node v24.22.1**, **pnpm 11.25.0**. Las copias de trabajo no recibieron `.env.local`, tokens de comprobantes ni credenciales.

| Comprobación | Resultado |
| --- | --- |
| Instalación original limpia | Fallo esperado con `ERR_PNPM_IGNORED_BUILDS`; reproduce la causa. |
| Resolución Linux/x64 | Fallo esperado con el nombre exacto del paquete de los logs. |
| Nuevo Install Command en limpio | Código 0, `devDependencies: skipped`, sin instalar las tres herramientas. |
| Política de scripts | `strictDepBuilds: true` en la verificación; sin aprobaciones de scripts. |
| Lockfile | Sin cambios tras la instalación de producción. |
| API tras instalar solo producción | **20/20 casos aprobados**, usando el código de la API en la copia limpia. |
| Compilador oficial | **`@vercel/node@31.0.2`**, con **`@vercel/build-utils@15.4.2`**, generó una función **`nodejs24.x`**. Las herramientas del compilador se instalaron fuera del repositorio. |
| Contenido trazado de la función | Solo `api/reservations.js` y `package.json`; sin módulos de las herramientas de pruebas, secretos ni SQL. |
| API empaquetada | **20/20 casos aprobados** sobre los archivos trazados por el compilador oficial. Son los mismos casos ejecutados en otro contexto, no 20 pruebas nuevas de comportamiento. |
| Batería local completa | **45 aprobadas, 0 fallidas y 0 omitidas**, incluidos los recorridos de navegador, PostgreSQL desechable, concurrencia, cancelación y seguridad. |

Para repetir las verificaciones mantenidas en el proyecto:

```sh
pnpm verify:production
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test:all
```

Las pruebas no contactaron producción ni cambiaron Supabase. La integración real de desarrollo aprobada previamente está documentada en `INTEGRACION_DESARROLLO_2026-11-17.md`; la presente corrección no cambia ese código funcional.

## Límite de la verificación

**No se ejecutó un build en Linux real ni una Preview remota.** La computadora no tiene un motor Linux/Docker disponible y la conexión de Vercel sigue devolviendo **403 `forbidden`** al leer `proyecto-aat` en el equipo `joseph-3fa9`. El usuario pudo leer los logs desde su sesión; el conector sigue sin ese acceso.

Se verificaron una instalación limpia, la resolución Linux/x64 y el empaquetado con el compilador oficial en un runtime soportado. Esos resultados preparan la corrección para probarla en Preview; la confirmación final en la infraestructura de Vercel queda pendiente. La configuración efectiva del proyecto tampoco pudo leerse con el conector.

## Próximos pasos para una Preview

1. Autorizar después el push y la creación de una Preview del **nuevo commit en la rama actual**. Reintentar el despliegue antiguo de `636b6ef` usaría el código anterior y no probaría esta corrección. No se hizo push ni se creó despliegue durante esta tarea.
2. En `joseph-3fa9/proyecto-aat`, revisar la raíz del proyecto y que se conserve la configuración de página estática más funciones Node. El Install Command debe ser el definido por `vercel.json`; no debe imponerse un `pnpm run build` inexistente.
3. Comprobar **Node 24.x** y el uso efectivo de **pnpm 11.25.0**. Para que Vercel respete `packageManager` mediante Corepack, revisar `ENABLE_EXPERIMENTAL_COREPACK=1` en el entorno **Preview**. No cambiar Production. El build local utilizó efectivamente pnpm 11.25.0; sin Corepack, la selección automática de versión de Vercel puede diferir.
4. Mantener las variables privadas de Preview apuntando a **MesaLista-Desarrollo**, referencia `udwanmsriljzgkeqbwwj`. Configurarlas directamente en Vercel sin compartir claves.
5. Para que Codex pueda revisar el build, dar a la integración acceso al equipo y a `proyecto-aat`, con lectura de **Deployment**, **Project** y **Team**. Como alternativa, el usuario puede compartir los nuevos logs sin secretos. No desactivar Deployment Protection.
6. Una vez autorizada la Preview, comprobar en Linux que la instalación omite las herramientas de pruebas, que se publican la página y `/api/reservations` y repetir el flujo con los datos ficticios de desarrollo.

La corrección está lista para esa prueba controlada. La Etapa 1 sigue abierta hasta validar la Preview y resolver los demás pendientes documentados, incluido el diagnóstico de conteos del catálogo publicado. No se inició Etapa 2.

## Referencias primarias

- [Vercel: configuración de instalación](https://vercel.com/docs/builds/configure-a-build): la instalación predeterminada incluye dependencias de desarrollo.
- [pnpm: install](https://pnpm.io/cli/install): `--prod` excluye `devDependencies`; `--frozen-lockfile` conserva el bloqueo.
- [pnpm: política de scripts](https://pnpm.io/settings/build): scripts no revisados y política estricta de instalación.
- [Vercel: gestores de paquetes y Corepack](https://vercel.com/docs/package-managers).
- [Vercel: imagen de compilación](https://vercel.com/docs/builds/build-image): Amazon Linux 2023 y runtimes admitidos.
