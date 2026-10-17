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

## Publicación automática desde main

Solo necesitas subir tus cambios a `main`:

```powershell
git push origin main
```

GitHub Actions aumenta automáticamente el parche (`0.1.0` → `0.1.1`), sincroniza `Cargo.toml`, `Cargo.lock` y `tauri.conf.json`, y guarda un commit del bot junto con su etiqueta. La compilación utiliza ese commit exacto.

Después ejecuta las pruebas, compila y firma el instalador. Prepara una release en borrador y la publica al comprobar que existen el instalador, su firma y `latest.json`. Finalmente descarga el paquete público, verifica su firma y confirma que la misma versión no se ofrece como actualización.

El mismo workflow prepara y publica: las subidas hechas con `GITHUB_TOKEN` no lanzan otro workflow, por lo que no se generan bucles ni dos compilaciones para la etiqueta automática. No se necesita agregar un token personal.

- Un reintento reutiliza la versión preparada. Una release ya publicada conserva sus archivos.
- Las publicaciones se ejecutan de una en una. Si llegan varias subidas mientras otra está en curso, se prioriza el estado más reciente de `main`.
- Si falla antes de publicar, el borrador no se anuncia a los usuarios. Puedes reejecutar la ejecución fallida en Actions.
- El bot añade un commit a `main`. Antes de empezar los próximos cambios, trae esa versión a tu copia local con `git pull --ff-only`.

### Regla de versiones

Se usa `X.Y.Z`. **Actions solo incrementa `Z` (parche)** dentro de la serie `X.Y` elegida por el responsable:

| Caso | Resultado |
|---|---|
| Siguiente subida en `0.1.x` después de `0.1.2` | `0.1.3` |
| Cambio manual a la serie `0.2.x` | Primera publicación `0.2.1` |
| Siguiente subida en `0.2.x` | `0.2.2` |
| Cambio manual a la serie `1.0.x` | Primera publicación `1.0.1` |

Para elegir una nueva serie, actualiza **los tres archivos** (`src-tauri/Cargo.toml`, el paquete `paritysql` de `src-tauri/Cargo.lock` y `src-tauri/tauri.conf.json`) a `0.2.0` o directamente a `0.2.1` y sube el cambio a `main`. En ambos casos se publicará `0.2.1`; los siguientes pushes aumentarán solo el parche. Una nueva serie con parche superior a `1` se rechaza, igual que volver a una serie anterior. La versión histórica `0.1.0` se conserva.

También se conserva la publicación mediante etiquetas manuales `vX.Y.Z` o desde **Run workflow**, seleccionando `main` o una etiqueta existente. Las etiquetas manuales deben respetar la misma regla y coincidir con los tres archivos. No modifiques una etiqueta distribuida.

Las reglas de protección de `main` deben permitir que Actions guarde el commit de versión. Si la rama rechaza esa escritura, el workflow falla sin forzar la subida.

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
