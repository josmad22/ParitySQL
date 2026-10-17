# Actualizaciones de ParitySQL

## Uso

La aplicación consulta automáticamente las [releases públicas de GitHub](https://github.com/josmad22/ParitySQL/releases) al abrirse y cada seis horas. Solo muestra el aviso si hay una versión superior.

1. Pulsa **Nueva versión disponible** para descargarla. Puedes seguir trabajando mientras termina.
2. La descarga se verifica con la clave pública incluida en la aplicación.
3. Cuando aparezca **Reiniciar ahora**, guarda o exporta tus scripts y pulsa el botón. El instalador actualiza la aplicación y la vuelve a abrir.

Ambos pasos son voluntarios. Los errores permiten reintentar; las conexiones guardadas se conservan. El aviso permanece oculto si no hay novedades o no se puede comprobar la versión.

## Primera instalación

Descarga el instalador **NSIS para Windows x64** desde [la última versión](https://github.com/josmad22/ParitySQL/releases/latest). Las compilaciones anteriores que tenían la fuente de actualizaciones vacía requieren esta instalación manual una sola vez.

El canal configurado es:

```text
https://github.com/josmad22/ParitySQL/releases/latest/download/latest.json
```

Las compilaciones de desarrollo pueden comprobar y descargar versiones, pero no instalar una actualización sobre el proceso de desarrollo.

## Publicar una nueva versión

1. Cambia la versión en `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json`. Actualiza también el paquete `paritysql` de `Cargo.lock` mediante Cargo.
2. Ejecuta las pruebas y sube el commit a `main`.
3. Crea y sube una etiqueta que coincida con esa versión:

```powershell
git tag v0.1.1
git push origin v0.1.1
```

El workflow `release.yml` valida la versión y la clave pública, ejecuta las pruebas, compila el instalador y firma el paquete. Primero prepara una release en borrador; al comprobar que existen el instalador, su firma y `latest.json`, la publica automáticamente. Finalmente descarga el paquete público, verifica la firma, rechaza un paquete alterado y comprueba que la misma versión no se ofrece como actualización.

También puedes reejecutar el workflow desde Actions seleccionando una **etiqueta** existente. Si falla antes de publicar, el borrador no se anuncia a los usuarios. No modifiques una etiqueta ya distribuida; publica una versión superior.

## Firma y claves

- `tauri.conf.json` contiene únicamente la **clave pública** y la URL del canal.
- La clave privada y su contraseña están en los secretos de Actions `TAURI_SIGNING_PRIVATE_KEY` y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- `PARITYSQL_UPDATER_PUBLIC_KEY` es una variable pública de Actions; debe coincidir con la clave incluida en el código.
- La copia privada local está fuera del repositorio, en `%USERPROFILE%/.tauri/ParitySQL/`. La contraseña está protegida con Windows DPAPI para el usuario que configuró la firma; la carpeta tiene acceso restringido.
- Conserva una copia segura de la clave privada y su contraseña. La copia DPAPI depende del usuario/equipo actual. No regeneres ni cambies la clave para una actualización normal: las instalaciones existentes confían en la clave original.
- No se distribuye un token de GitHub. El paquete se descarga por HTTPS y su firma se verifica antes de ofrecer reiniciar y antes de instalar. No se permiten downgrades ni excepciones TLS.

Esta firma protege el mecanismo de actualizaciones; no es un certificado Authenticode de Windows.

## Compilación local

El desarrollo y las compilaciones normales no necesitan la clave privada:

```powershell
cargo tauri dev
cargo tauri build
```

Para generar el instalador y su firma desde el usuario de Windows que configuró las claves:

```powershell
./scripts/build-release.ps1
```

El script recupera la contraseña protegida, prepara un override ignorado por Git y entrega las claves únicamente al proceso de compilación. Los artefactos quedan en `src-tauri/target/release/bundle/nsis/`.

## Verificación del canal real

Esta prueba usa GitHub y descarga el instalador. No lo instala ni reinicia la aplicación:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib published_update -- --ignored --nocapture
```

Las pruebas normales no necesitan red ni claves privadas. Referencia: [Updater oficial de Tauri](https://v2.tauri.app/plugin/updater/).
