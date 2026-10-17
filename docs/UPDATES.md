# Actualizaciones de ParitySQL

## Estado inicial

La función está implementada y **desactivada mientras no se configure una fuente**.
En `src-tauri/tauri.conf.json`, `plugins.updater.pubkey` queda vacío y `endpoints`
es una lista vacía. No se genera ninguna clave privada al instalar o abrir la app.
El desarrollo y las compilaciones normales funcionan sin repositorio ni claves.

## Comportamiento

- Se comprueba al iniciar, cada seis horas y al recuperar conexión/enfoque cuando
  corresponde. Sin una versión superior no aparece ningún botón.
- Una versión disponible muestra un botón pequeño en la esquina inferior derecha.
  Su animación respeta la preferencia del sistema de reducir movimiento.
- Al pulsarlo se descarga el paquete por HTTPS y se verifica su firma mediante el
  plugin oficial de Tauri. Hasta completar esa verificación no se ofrece reiniciar.
- **Reiniciar ahora** instala el paquete y vuelve a abrir ParitySQL. En Windows el
  instalador cierra el proceso: por eso descargar e instalar son pasos separados.
- Un fallo de descarga o instalación permite reintentar. Los fallos de comprobación
  automática no interrumpen el trabajo con avisos de error.
- El paquete preparado queda en memoria. Si se cierra por completo la aplicación
  sin instalar, se descargará de nuevo cuando se solicite. Recargar solo la interfaz
  recupera el estado de la operación que permanece en Rust.
- El reinicio espera los guardados de conexiones y no se inicia durante una consulta,
  importación o edición de conexiones. Los scripts de trabajo siguen en memoria:
  deben copiarse/exportarse antes de reiniciar.

## Cuando exista el repositorio público

1. Genera una pareja de claves con `cargo tauri signer generate --write-keys RUTA`
   en un directorio privado **fuera del repositorio**. Conserva una copia segura de
   la clave privada; las versiones instaladas confían en su pareja pública.
2. En GitHub, crea la variable de Actions `PARITYSQL_UPDATER_PUBLIC_KEY` con el contenido
   del archivo `.pub`. El script de publicación rechaza el formato de una clave privada.
3. Crea el secreto de Actions `TAURI_SIGNING_PRIVATE_KEY` con la clave privada, y
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` si le asignaste contraseña. Ninguna de estas
   claves privadas se guarda en los archivos del proyecto.
4. Mantén iguales las versiones de `src-tauri/Cargo.toml` y `tauri.conf.json`.
   Crea una etiqueta `v` seguida de esa versión, por ejemplo `v0.1.0`.
5. El workflow `release.yml` verifica las pruebas, prepara la configuración pública
   a partir de `github.repository`, genera un instalador **NSIS firmado** y crea una
   release en borrador con el instalador, su firma y `latest.json`.
6. Publica la release terminada. Solo entonces la consulta a la última release
   pública podrá anunciarla a las instalaciones anteriores.

La URL se construye como
`https://github.com/PROPIETARIO/REPOSITORIO/releases/latest/download/latest.json`.
No se necesita incluir un token de GitHub en la aplicación instalada.

La primera instalación que incluya la configuración real debe distribuirse e
instalarse manualmente. Una instalación compilada con la configuración vacía no
puede descubrir por sí misma una URL que aún no conoce. Usa el instalador NSIS
de esta distribución para las posteriores actualizaciones automáticas.

## Compilación firmada desde Windows

El workflow prepara automáticamente un override ignorado por Git. También puede
generarse de forma local cuando ya se disponga del repositorio y la clave pública:

```powershell
./scripts/prepare-release.ps1 -Repository PROPIETARIO/REPOSITORIO -PublicKey (Get-Content RUTA_PUBLICA.pub -Raw)
```

Configura `TAURI_SIGNING_PRIVATE_KEY` y, si corresponde,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` como variables de entorno locales. Después:

```powershell
cargo tauri build --locked --config src-tauri/tauri.release.local.json
```

Las claves privadas solo se utilizan durante la firma. La configuración compilada
contiene únicamente la clave pública y el endpoint HTTPS. El override es
`src-tauri/tauri.release.local.json` y está excluido por `*.local.json`.

## Validación

Las pruebas Node verifican estados, progreso, ocultación, doble clic, reintentos,
reinicio explícito y recuperación de operaciones. Las pruebas Rust verifican el
modo desactivado y el rechazo de configuraciones inseguras.

Una actualización real entre dos instaladores debe probarse cuando existan el
repositorio y la clave de firma. El modo de desarrollo permite comprobar/descargar
si se configura, pero bloquea la instalación sobre la aplicación de desarrollo.

Referencia: [plugin oficial Updater de Tauri](https://v2.tauri.app/plugin/updater/).
