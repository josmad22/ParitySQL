# Revisión previa a publicación

Fecha: 2026-10-17. Aplicación: ParitySQL.

## Alcance y resultados

- Revisados los archivos versionados existentes y los nuevos archivos no ignorados, incluidos código, documentación, iconos y workflow de publicación.
- Gitleaks 8.30.1, obtenido del repositorio oficial y verificado contra su checksum SHA-256: sin secretos detectados en los archivos publicables ni en los cuatro commits accesibles del historial.
- Búsqueda adicional en 149 blobs históricos y en el árbol actual: sin claves privadas, tokens reconocibles, URL con credenciales, IP privadas o referencias a los entornos internos anteriores.
- Los campos de servidor del prototipo HTML archivado se dejaron vacíos. Ese archivo no forma parte del frontend de la aplicación.
- Los campos de credenciales del programa son entradas del usuario, no valores precargados. La configuración de actualizaciones sigue sin clave ni endpoint.
- Verificadas las exclusiones de variables de entorno, conexiones, ajustes locales, claves privadas, exportaciones SQL, respaldos y compilaciones. Los ajustes locales encontrados no están versionados.
- La configuración de conexiones de la instalación local estaba vacía durante la revisión y reside fuera del repositorio.
- Git no tiene remotos configurados ni objetos inalcanzables detectados por `git fsck --full --no-reflogs --unreachable`.

## Datos personales y límites

El historial conserva el nombre y correo de su autor; el correo no utiliza el dominio de anonimización de GitHub. Esos metadatos se publicarían junto con los commits. No se reproducen aquí sus valores.

La aplicación guarda las contraseñas introducidas por el usuario en texto plano en su configuración local. Este archivo está fuera del código distribuido y excluido de Git si se copia al proyecto. La revisión para publicación no cambia ese comportamiento.

La revisión no garantiza la ausencia absoluta de datos sensibles ni constituye una auditoría completa de vulnerabilidades. Debe repetirse después de añadir archivos o configurar la publicación. Un archivo ignorado puede incluirse con `git add -f`; `.gitignore` no borra contenido ya presente en commits.

No se eliminó `.git`, no se reescribió el historial y no se publicó contenido. Un historial nuevo puede crearse desde una copia de los archivos publicables si se decide omitir también los metadatos anteriores.

Herramienta: [Gitleaks](https://github.com/gitleaks/gitleaks).

## Copia preparada para publicación

La copia pública se preparó desde los archivos actuales publicables, sin copiar el directorio `.git` ni las configuraciones ignoradas. Su historial comienza con un único commit inicial que utiliza el correo de anonimización de GitHub. El proyecto original y su historial se conservaron como respaldo local.

Antes de publicar, Gitleaks volvió a revisar esta copia sin detectar secretos. Se verificaron 31 pruebas JavaScript y 11 pruebas Rust sobre el mismo código fuente.
