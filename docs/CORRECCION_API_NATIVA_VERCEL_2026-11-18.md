# Instalación de la función nativa de reservas en Vercel

18 de noviembre de 2026. Solo Etapa 1.

Las Preview `dpl_37g1JcV6dN8aHgmJisQzd9B2WYfR` y `dpl_EMpqujRrs3xWSYJmTT64BxEoxYN9` del código `94f00e4` fallaron con `ERR_PNPM_IGNORED_BUILDS`. Corepack sí seleccionó pnpm 11.25.0. Ambas eran Preview, con variables separadas de Production y URL de MesaLista-Desarrollo verificada.

El compilador de funciones nativas de `/api` puede ejecutar su instalación predeterminada aunque exista un Install Command general. La verificación anterior utilizaba `considerBuildCommand: true` en el compilador oficial y no reproducía el modo nativo que estaba fallando. La [documentación de Vercel](https://vercel.com/docs/builds/configure-a-build#custom-install-command-for-your-api) describe la separación entre esos instaladores.

Se añaden `api/package.json` y `api/pnpm-lock.yaml` para que la función tenga su propio paquete sin dependencias externas, con Node 24 y pnpm 11.25.0. El instalador nativo encuentra ese límite antes de llegar a las herramientas de pruebas de la raíz. La función de reservas no cambia, ni se eliminan pruebas ni dependencias de desarrollo. El lockfile de la raíz y la política de scripts se conservan.

`scripts/verify-production-install.cjs` ahora verifica también `pnpm install --frozen-lockfile` dentro del paquete de la API. El archivo de workspace que ese verificador crea para probar la política estricta de la instalación general se elimina únicamente dentro de su directorio temporal antes de comprobar la API, porque el repositorio real no es un workspace.

La instalación limpia aprobó y ejecutó los 20 casos de la API. El compilador oficial `@vercel/node@31.0.2`, usando `considerBuildCommand: false`, aprobó la instalación predeterminada y generó una función `nodejs24.x` que contiene únicamente `api/reservations.js` y `api/package.json`. Los 20 casos también aprobaron sobre esos archivos trazados. Esta comprobación local se ejecutó en macOS; la nueva Preview debe confirmar el resultado en Linux y después probar reservas reales de desarrollo.

El push de la rama autorizada sigue pendiente de autenticación Git local en GitHub. Se comprobó HTTPS y SSH; no se obtuvieron ni expusieron tokens. La conexión GitHub del chat permite consultas, pero su herramienta de crear commits no permite conservar todos los metadatos de los commits locales. No se reconstruyó ni reescribió el historial. El despliegue Preview autorizado puede realizarse mediante los archivos versionados del commit local, dejando documentada esta diferencia respecto de un push.

No se modificaron producción, migraciones, datos personales ni la rama de respaldo. No se inició Etapa 2.
