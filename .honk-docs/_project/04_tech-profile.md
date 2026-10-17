# Tech Profile

> Real stack and project commands. Planning and apply skills use this file to
> avoid proposing unavailable tools or incorrect commands.

## Languages

| Language | Version | Main use |
|---|---|---|
| Rust | edition 2021, compilador >= 1.90 | Backend: conexión SQL Server, generación de scripts, persistencia. |
| JavaScript | ES (sin transpilar) | Frontend: UI, estado, llamadas IPC. |
| HTML / CSS | — | Estructura y estilos del frontend. |

## Frameworks and Libraries

| Name | Version | Purpose |
|---|---|---|
| Tauri | 2 (lockfile: 2.12) | Framework de app de escritorio + empaquetado (bundler). |
| tiberius | 0.12 | Driver SQL Server (feature `sql-browser-tokio`). |
| tokio | 1 | Runtime async (`rt-multi-thread`, `net`, `macros`, `fs`). |
| tokio-util | 0.7 | Compat entre tokio y tiberius (`compat`). |
| serde / serde_json | 1 | Serialización IPC y persistencia JSON. |
| tauri-plugin-updater | 2 (lockfile: 2.14) | Comprobación, descarga firmada e instalación de actualizaciones. |
| rfd | 0.15 | Diálogos nativos de archivo (guardar `.sql`). |

## Database

| Engine | Version | Use |
|---|---|---|
| SQL Server | [pendiente — cualquier versión soportada por tiberius 0.12] | **Consumida, no poseída**: lectura de metadatos + generación de T-SQL. |

## Runtime and Platform

**Runtime:** WebView2 (frontend) + binario nativo Rust con tokio (backend).

**Platform:** Windows 11 (WebView2 incluido; autenticación integrada Windows).

**Package manager:** Cargo (Rust). El frontend no usa gestor de paquetes.

## Commands

```bash
# Test
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
node --test

# Build
cargo tauri build   # genera .exe (NSIS) + .msi en src-tauri/target/release/bundle

# Lint
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check

# Dev server
cargo tauri dev   # ejecuta la app con recarga

# Migrations
# N/A — la app no administra un esquema de base de datos propio
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| Runtime | No requiere variables de entorno; conexiones en `environments.json` y configuración pública de actualización compilada. | — |
| `TAURI_SIGNING_PRIVATE_KEY` | Solo durante compilaciones firmadas; clave privada fuera del repositorio. | Sin configurar |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Contraseña opcional de la clave de firma durante compilación. | Sin configurar |
| `PARITYSQL_UPDATER_PUBLIC_KEY` | Variable pública del workflow de releases; véase `docs/UPDATES.md`. | Sin configurar |

## Forbidden Libraries or Practices

- No introducir bundler ni framework JS en el frontend (se mantiene JS plano).
- No abrir conexiones a SQL Server desde el frontend; toda E/S a SQL Server va por Rust.
- No precargar entornos con credenciales en `default_store()` (builds deben ser
  limpios y distribuibles).
