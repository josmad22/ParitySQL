# Arquitectura de ParitySQL

## Estilo y límites

Aplicación monolítica de escritorio con dos capas: frontend estático en WebView2
y backend nativo Rust. La comunicación entre ambas usa comandos IPC de Tauri v2.
No se introduce un framework, bundler, API HTTP propia ni esquema de base de datos.

## Responsabilidades

| Módulo | Responsabilidad |
|---|---|
| `src/index.html` / `src/styles.css` | Estructura y presentación de la interfaz. |
| `src/main.js` | Estado compartido de conexiones/base, selección de herramienta, extracción, modal y coordinación IPC. Serializa los guardados mediante una cola de instantáneas. |
| `src/compare.js` | Dominio puro: lectura de definiciones, parámetros, diferencias, alineación y decodificación de SQL. Sin DOM, red, IPC ni persistencia. Exporta `SqlCompare` al navegador y CommonJS a las pruebas de Node. |
| `src/compare-workspace.js` | Controlador de comparación: entrada pegada/archivos, selección de objetos, render, navegación y desplazamiento sincronizado. Recibe `invoke`, contexto y notificaciones por inyección desde `main.js`. |
| `src/updates.js` | Controlador del aviso flotante: comprobaciones automáticas, progreso y reinicio explícito. Recibe IPC, Channel y guardas de operación por inyección. |
| `src/highlight.js` | Resaltado T-SQL con escape HTML previo. |
| `src-tauri/src/main.rs` | Entrada del ejecutable; delega en `paritysql_lib::run()`. |
| `src-tauri/src/lib.rs` | Adaptadores IPC y registro de comandos. Delega las operaciones a sus módulos. |
| `src-tauri/src/sql.rs` | Configuración/conexión TDS, consultas de metadatos y generación de scripts. |
| `src-tauri/src/store.rs` | Lectura y reemplazo del JSON de conexiones en el directorio de configuración de la app. |
| `src-tauri/src/files.rs` | Diálogo nativo y escritura asíncrona de scripts exportados. |
| `src-tauri/src/updates.rs` | Estado de actualización en Rust, consultas HTTPS, descarga y verificación de firma, instalación al reiniciar. |

## Contrato IPC

| Comando | Entrada | Resultado correcto |
|---|---|---|
| `test_connection` | `conn` | `{ ok, version, latencyMs }` |
| `list_databases` | `conn` | Lista de nombres de bases, sin bases de sistema. |
| `generate_scripts` | `conn, database, objects: string[]` | `{ objects, totalObjects, okObjects, totalLines, header, script }` |
| `fetch_definitions` | `conn, database, objects: [{ schema, name }]` | Lista en el orden solicitado: `{ definition, error, status }`. |
| `load_environments` | Sin entrada. | `{ environments, activeEnv, currentDb }` |
| `save_environments` | `store` | `()` |
| `save_script` | `content, filename` | Ruta guardada o `null` al cancelar. |
| `check_for_updates` | Sin entrada. | `{ phase, version }`; sin configuración devuelve `disabled`. |
| `download_update` | `progress: Channel` | `{ phase, version }`; progreso `{ downloaded, total }` por canal IPC. |
| `install_update` | Sin entrada. | Instala únicamente el paquete ya descargado y verificado; reinicia o devuelve error. |

Los campos compuestos se serializan en `camelCase` mediante `serde`. Los errores
se rechazan como `String`; las interfaces muestran los fallos en español.
`fetch_definitions` distingue `ok`, `missing`, `unavailable` y `error`. Tanto la
extracción como la consulta de definiciones acumulan errores por objeto.

## Flujos

- Extracción: nombres → `generate_scripts` → consultas parametrizadas de metadatos
  → bloques DROP/CREATE y propiedades → presentación / portapapeles / exportación.
- Comparación: texto o archivos seleccionados por el usuario → dominio local →
  objetos detectados → `fetch_definitions` con la conexión/base compartidas →
  comparación local → filas alineadas y navegación por diferencias.
- El entorno representa la versión actual; el origen es la propuesta. Las altas
  se muestran en origen y las bajas en entorno. Nunca se ejecuta el SQL pegado.
- El controlador de comparación invalida respuestas anteriores al cambiar el
  contenido o la conexión, y aplaza consultas automáticas mientras el modal está abierto.

## Persistencia y concurrencia

- Solo las conexiones/base seleccionada se persisten automáticamente. El SQL
  pegado/importado y los resultados de comparación permanecen en memoria.
- `main.js` captura una instantánea por guardado y espera el guardado anterior.
  No anuncia éxito si el backend rechaza la operación.
- Solo la ausencia del JSON se interpreta como instalación nueva. Un archivo
  inválido o sin permisos produce un error visible y no se modifica al cargar.
- `store.rs` escribe un archivo temporal en el mismo directorio, sincroniza sus
  bytes y reemplaza `environments.json`. Si falla, conserva el archivo anterior
  y elimina el temporal cuando es posible.
- La lectura/escritura síncrona de configuración se ejecuta con `spawn_blocking`.
  La exportación usa `tokio::fs`; el hilo de UI no escribe archivos directamente.
- Los scripts exportados solo se escriben tras la elección del usuario en el
  diálogo nativo. Cancelar devuelve `null` sin escribir.

## Actualizaciones de la aplicación

- El plugin `tauri-plugin-updater` se usa desde Rust; no se agrega un bundler al frontend.
- La clave pública y el endpoint de `josmad22/ParitySQL` están incluidos en la
  configuración pública de compilación. Solo se anuncia una versión superior
  publicada en GitHub Releases.
- La descarga permanece en memoria y no se ofrece reiniciar antes de verificar su
  firma. La instalación vuelve a verificarla. Solo se aceptan fuentes HTTPS y no
  se habilitan excepciones TLS ni downgrades.
- El estado pendiente se conserva en Rust ante una recarga del WebView. En Windows
  el instalador termina el proceso al instalar: por eso la descarga y el reinicio
  solicitado por el usuario son operaciones separadas.
- El reinicio espera guardados y no interrumpe operaciones o el modal de conexiones.
- La distribución usa releases NSIS firmadas. Al subir una etiqueta de versión,
  el workflow prepara un borrador con instalador, firma y `latest.json`, comprueba
  sus artefactos y lo publica automáticamente. Después verifica el canal real.
- La clave privada solo existe como secreto del proceso de firma; no se compila ni
  se guarda en el repositorio. Véase `docs/UPDATES.md`.

## Interfaces externas y compatibilidad

| Interfaz | Uso |
|---|---|
| SQL Server / TDS | Solo lectura de metadatos mediante `tiberius`, con autenticación SQL o integrada de Windows. |
| SQL Browser | Resolución de instancias `HOST\INSTANCIA`. |
| Sistema de archivos | Configuración local y exportación elegida por el usuario. |
| GitHub Releases / HTTPS | Canal público de versiones y paquetes firmados de `josmad22/ParitySQL`. |
| Google Fonts | Tipografías opcionales de la interfaz; existen fuentes locales de respaldo. |

Se conserva `com.sphelper.sqlhelptext` como identificador de aplicación para
mantener la ruta de configuración y la compatibilidad con instalaciones previas.
El nombre visible y el ejecutable son ParitySQL / `paritysql`.

## Seguridad y límites actuales

- Configuración inicial vacía; no se distribuyen conexiones ni credenciales.
- Toda conexión a SQL Server ocurre en Rust. Los nombres consultados se envían
  como parámetros; el SQL de origen nunca se ejecuta.
- Las contraseñas que el usuario decide guardar siguen en texto plano en el JSON
  local, excluido de Git. No se ha introducido un almacén de credenciales.
- La configuración TLS actual confía en el certificado del servidor. La CSP de
  Tauri no está configurada. Son limitaciones existentes; no equivalen a una
  validación de seguridad completa y requieren un cambio de alcance para endurecerlas.

## Decisiones

- 2026-07: configuración inicial vacía para distribuir sin datos privados.
- 2026-10-16: documentar comparación como dominio local independiente, mantener
  contratos IPC, aislar exportación y completar guardados sin bloquear la UI.
