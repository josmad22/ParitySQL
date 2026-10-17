# Standards

> Code standards for generated and modified code. `honk-fast-apply` and the
> legacy pipeline must treat these rules as project constraints.

## Required

- Structs de frontera IPC anotadas con `#[serde(rename_all = "camelCase")]`.
- Errores de backend como `Result<T, String>` con mensajes legibles en español.
- Errores por objeto acumulados (`err_result`) sin abortar el lote.
- Comentarios `///` en funciones Rust no obvias (parsing, config, propiedades).

## Forbidden

- Bundler o framework JS en el frontend.
- Conexiones a SQL Server desde el frontend.
- Entornos precargados con credenciales en el binario.

## Naming

| Element | Convention | Example |
|---|---|---|
| Variables | snake_case (Rust) / camelCase (JS) | `type_code`, `dbFiltered` |
| Functions | snake_case (Rust) / camelCase (JS) | `build_config`, `renderTopbar` |
| Classes | CamelCase (structs Rust) | `ConnConfig`, `GenResult` |
| Constants | SCREAMING_SNAKE (Rust) | `[pendiente]` (no hay constantes destacadas) |
| Files | snake_case (Rust) / kebab o corto (frontend) | `store.rs`, `main.js` |
| Directories | kebab / corto | `src-tauri`, `src` |

## Folder Structure

```text
src/            frontend estático (HTML/CSS/JS, sin bundler)
  index.html    interfaz
  styles.css    estilos
  main.js       lógica + llamadas a comandos Tauri
  highlight.js  resaltador T-SQL
  compare.js    dominio puro de parsing y comparación (sin DOM ni IPC)
  compare-workspace.js  controlador de la vista de comparación
  updates.js    controlador de avisos de actualización
src-tauri/      backend Rust
  src/main.rs   entry point
  src/lib.rs    comandos Tauri (invoke_handler)
  src/sql.rs    conexión y generación (tiberius)
  src/store.rs  persistencia de entornos (JSON)
  src/files.rs  exportación mediante diálogo nativo
  src/updates.rs  estado y operaciones de actualización firmada
  tauri.conf.json / Cargo.toml
```

## Import Rules

- Rust: `use` explícito por módulo; sin globs salvo prelude de librería.
- JS: sin módulos ES ni imports; scripts cargados por `<script>` en orden
  (`highlight.js`, `compare.js`, `compare-workspace.js`, `updates.js`, `main.js`).

## Error Handling

- E/S de configuración fuera del hilo de UI; comandos delegan en módulos de infraestructura.
- Guardados de configuración ordenados y reemplazo completo del JSON.
- Dominio de comparación independiente del DOM y del IPC.
- Backend: `map_err(|e| format!(...))` con mensaje en español; nunca `unwrap` sobre
  E/S de red o consultas.
- Frontend: los errores se muestran vía `toast(msg, "err")`.

## Formatting

**Formatter:** `rustfmt` (estándar Rust). Frontend sin formateador configurado.

- Rust: estilo `rustfmt` por defecto.
- JS/CSS: estilo manual coherente con el existente (2 espacios, comillas dobles).

## Comments

- Idioma de comentarios y mensajes: español.
- Rust: `///` para doc de funciones; `//` para secciones.
- JS: comentarios de sección con `// ---------- nombre ----------`.
