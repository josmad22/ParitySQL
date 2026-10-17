# Init: paritysql

**Escenario:** EXISTENTE
**Fecha:** 20260721
**Estado:** APROBADO — _project/ generado el 20260722

> Alcance: se documentó todo el codebase **excepto la carpeta `docs/`** (omitida por
> instrucción del desarrollador).

---

## Resumen del proyecto

**ParitySQL** (identificador interno `paritysql` / bundle `com.sphelper.sqlhelptext`)
es una mini herramienta de escritorio para SQL Server construida con **Rust + Tauri
v2**. El usuario pega una lista de objetos de base de datos (procedimientos,
funciones, vistas, triggers, tablas), pulsa **Ejecutar** y la app genera, por cada
objeto, un script `DROP IF EXISTS` + `CREATE` a partir de la definición real
obtenida del servidor (`OBJECT_DEFINITION`), listo para copiar o descargar como
`.sql`.

Su valor es acelerar la extracción de scripts de despliegue/versión desde un SQL
Server real, respetando esquema, tipo de objeto y propiedades extendidas
(`MS_Description`). Soporta autenticación SQL Server y Windows integrada, instancias
con nombre (`HOST\INSTANCIA` vía SQL Browser) y `HOST,puerto`, y permite guardar
varios **entornos** de conexión con su base por defecto.

Punto arquitectónico importante: **la aplicación no posee un esquema de base de
datos propio**. Su única persistencia local es un archivo JSON de entornos en el
directorio de configuración de la app. Toda interacción con SQL Server es de
**solo lectura de metadatos** (consultas a `sys.objects`, `sys.databases`,
`sys.extended_properties`) más la generación de T-SQL de salida.

---

## Lo que irá en cada doc de _project/

### 01 — Project Context

- Propósito del sistema: generar scripts `DROP IF EXISTS` + `CREATE` de objetos de
  SQL Server a partir de su definición real en el servidor.
- Usuarios objetivo: desarrolladores/DBAs internos que versionan o despliegan
  objetos de SQL Server. Uso interno (sin autenticación de app, sin multiusuario).
- Módulos principales (alto nivel):
  - Frontend estático (HTML/CSS/JS sin bundler): UI, gestión de entornos, cola de
    objetos, render de resultados con resaltado T-SQL.
  - Backend Rust/Tauri: comandos `invoke` que conectan a SQL Server, listan bases,
    generan scripts, persisten entornos y guardan `.sql`.
- Términos críticos de dominio: entorno (environment), objeto, esquema/`dbo`,
  definición (`OBJECT_DEFINITION`), propiedad extendida, script generado.

### 02 — Glossary

| Término | Definición |
|---------|------------|
| Entorno (environment) | Configuración de conexión guardada (nombre, servidor, puerto, autenticación, usuario/contraseña, base por defecto, color). Persistida en `environments.json`. |
| Objeto | Elemento de SQL Server a procesar: procedimiento, función, vista, trigger o tabla. Se ingresa uno por línea; sin esquema asume `dbo`. |
| Esquema | Prefijo `schema.objeto`. Si se omite, se asume `dbo`. |
| Definición | Texto T-SQL del `CREATE` real, obtenido con `OBJECT_DEFINITION(object_id)`. |
| Propiedad extendida | Metadato de `sys.extended_properties` (p. ej. `MS_Description`) re-creado tras el DROP/CREATE con `sp_addextendedproperty`. |
| Script generado | Cabecera `USE [db]; GO` + bloques `DROP`/`CREATE` por objeto, con banda de comentario `═` y numeración `Objeto i de N`. |
| Comando Tauri | Función Rust expuesta al frontend vía `invoke_handler` (p. ej. `generate_scripts`). |

### 03 — Architecture

**Estilo arquitectónico:** Aplicación de escritorio monolítica de dos capas —
frontend web (WebView2) + backend nativo Rust — comunicadas por el puente IPC de
Tauri (`window.__TAURI__.core.invoke`).

**Módulos principales:**

| Módulo | Responsabilidad |
|--------|-----------------|
| `src/index.html` | Estructura de UI: topbar (entorno/base), panel de objetos, panel de resultado, modal de conexión, toast. |
| `src/main.js` | Estado en memoria, render, cola de objetos, llamadas a comandos Tauri, persistencia vía `save_environments`. |
| `src/highlight.js` | Resaltador de sintaxis T-SQL para el resultado. |
| `src/styles.css` | Estilos (paleta del diseño original). |
| `src-tauri/src/main.rs` | Entry point; delega en `paritysql_lib::run()`. |
| `src-tauri/src/lib.rs` | Registro de comandos Tauri (`invoke_handler`). |
| `src-tauri/src/sql.rs` | Conexión a SQL Server (tiberius), test, listado de bases y generación de scripts. |
| `src-tauri/src/store.rs` | Persistencia de entornos en JSON (`app_config_dir/environments.json`). |

**Comandos Tauri (contrato frontend↔backend):**

| Comando | Entrada | Salida |
|---------|---------|--------|
| `test_connection` | `conn` | `{ ok, version, latencyMs }` |
| `list_databases` | `conn` | `Vec<String>` (excluye system DBs) |
| `generate_scripts` | `conn, database, objects` | `GenResult` (objetos + script) |
| `load_environments` | — | `Store` |
| `save_environments` | `store` | `()` |
| `save_script` | `content, filename` | `Option<String>` (ruta guardada) |

**Restricciones arquitectónicas:**

- Frontend sin bundler ni framework: JS plano servido como `frontendDist` estático.
- Toda E/S a SQL Server ocurre en el backend Rust (async con tokio); el frontend
  nunca abre conexiones.
- La app no posee esquema propio: la única escritura de estado es `environments.json`.
- Windows-only en la práctica (WebView2 + `windows_subsystem`, autenticación
  integrada Windows).

**Patrones en uso:** Command pattern vía Tauri `invoke`; separación UI (JS) /
dominio-datos (Rust); serialización `serde` con `rename_all = "camelCase"` en el
límite IPC.

### 04 — Tech Profile

- Lenguaje: Rust (edition 2021) en backend; JavaScript (ES, sin transpilar) + HTML +
  CSS en frontend.
- Framework: Tauri v2 (backend + empaquetado); sin framework JS en frontend.
- Base de datos: **consumida, no poseída** — SQL Server (driver `tiberius` 0.12).
  Persistencia propia: archivo JSON (`serde_json`), no un motor de BD.
- Runtime: WebView2 (Windows 11); async con `tokio` (rt-multi-thread).
- Dependencias clave (Cargo): `tauri`, `serde`, `serde_json`, `tokio`, `tokio-util`,
  `tiberius` (feature `sql-browser-tokio`), `futures-util`, `rfd` (diálogos de archivo).
- Test command: `cargo test` (no hay tests aún — ver 06).
- Build command: `cargo tauri build` (genera `.exe` NSIS + `.msi` en
  `src-tauri/target/release/bundle/`). Dev: `cargo tauri dev`.
- Lint command: `cargo clippy` (estándar Rust; no configurado explícitamente en repo).
- Perfil release: `strip = true`, `lto = true`, `opt-level = "s"` (binario pequeño).

### 05 — Code Standards

- Naming: Rust idiomático (snake_case funciones/campos, CamelCase tipos). Structs de
  frontera IPC con `#[serde(rename_all = "camelCase")]`. JS: camelCase, helper `$` =
  `getElementById`. Objetos SQL: `esquema.objeto`, default `dbo`.
- Estructura de carpetas: `src/` (frontend estático) y `src-tauri/src/` (backend Rust,
  un archivo por responsabilidad: `lib`, `sql`, `store`). `docs/` **[fuera de alcance,
  omitida]**.
- Reglas de error handling: backend devuelve `Result<T, String>`; los errores se
  mapean a mensajes en español legibles (`map_err(|e| format!(...))`). El frontend los
  muestra vía `toast(msg, "err")`. Errores por objeto se acumulan sin abortar el lote
  (`err_result`).
- Documentación inline: comentarios `///` en Rust para funciones no obvias (parsing,
  build de config, propiedades extendidas). Comentarios de sección con `// ----------`
  en `main.js`. Idioma de comentarios: español.

### 06 — QA Standards

- Estrategia de testing: **actualmente inexistente** — no hay tests unitarios,
  de integración ni e2e en el repo. `[pendiente — confirmar estrategia deseada]`
- Cobertura mínima: `[pendiente — confirmar con el desarrollador]`
- Test framework: no configurado. Estándar disponible: `cargo test` /
  `#[tokio::test]` para código async.
- Qué NO se testea: `[pendiente]`. Candidatos naturales a cubrir cuando se defina:
  `parse_object`, `map_type`, `sql_escape`, `build_ext_block`, `build_block`
  (funciones puras, fácilmente testeables sin servidor).

### 07 — Infra

- Entornos: aplicación de escritorio de distribución única; **no** hay dev/staging/prod
  de servidor. Los "entornos" del producto son conexiones SQL Server del usuario, no
  ambientes de despliegue.
- Cloud / plataforma: ninguna. Distribución como instalador Windows (NSIS `.exe` +
  `.msi`).
- CI/CD: **ninguno** (sin `.github/workflows`). Build manual con `cargo tauri build`.
  `[pendiente — confirmar si se desea pipeline]`
- Variables de entorno requeridas: ninguna. Configuración de usuario en
  `%APPDATA%/com.sphelper.sqlhelptext/environments.json`.
- Nota de seguridad (del README): las contraseñas de entorno se guardan en **texto
  plano** en ese JSON. Uso interno. Mejora sugerida: Windows Credential Manager.

### 08 — Conventions

- Git branching: `[pendiente — confirmar]`. Estado actual: rama `main`, historial de
  un solo commit (`Init: helptext helper`).
- Commit format: `[pendiente — confirmar]`. Ejemplo existente en estilo breve
  imperativo con prefijo (`Init: ...`).
- PR process: `[pendiente — confirmar]`. Sin plantillas ni CI que lo respalde.
- Otras convenciones: `.gitignore` excluye `src-tauri/target`, `gen/schemas` y la
  config local de HonkFlow. Idioma del proyecto (UI, comentarios, mensajes de error):
  español.

### 09 — Database Standards

> La app **no administra un esquema propio**: no crea tablas, no versiona una BD, no
> usa migraciones. Interactúa con SQL Server de dos formas: (a) consultas de solo
> lectura a vistas de sistema, y (b) generación de T-SQL de salida. Los estándares
> siguientes describen ese T-SQL generado y las convenciones observadas.

- Motor de base de datos: SQL Server (T-SQL). Driver: `tiberius`.
- Convenciones de nombres: objetos calificados `esquema.objeto`; sin esquema se asume
  `dbo`. Se preservan corchetes solo en la cabecera `USE [db]`.
- Tipos de datos preferidos: N/A (la app no define columnas). En consultas de sistema
  usa `CAST(... AS NVARCHAR(MAX))` para valores de propiedades extendidas.
- Reglas de llaves y constraints: N/A (no se crean objetos propios).
- Estrategia de migraciones / herramienta: **ninguna** — no aplica. La persistencia
  es un JSON, no un esquema versionado.
- Organización de scripts: no hay carpeta `bd_scripts` propia; los scripts son
  **generados en runtime** y exportados por el usuario como `.sql` — extensión: `.sql`.
- Columnas estándar (audit, timestamps): N/A.

**Ejemplos (DDL/DML reales — extraídos del codebase):**

- Create table: N/A — la app no crea tablas propias. `[no aplica]`
- Insert: N/A — sin escritura a SQL Server. `[no aplica]`
- Consulta de metadatos (real, `sql.rs`):
  ```sql
  SELECT o.type, OBJECT_DEFINITION(o.object_id)
  FROM sys.objects o WHERE o.object_id = OBJECT_ID(@P1)
  ```
- Listado de bases (real, `sql.rs`):
  ```sql
  SELECT name FROM sys.databases
  WHERE state = 0 AND name NOT IN ('master','tempdb','model','msdb')
  ORDER BY name
  ```
- Script generado — bloque DROP/CREATE (real, formato de `build_block`):
  ```sql
  /* ═══ Objeto 1 de N · dbo.usp_Ejemplo (procedimiento) ═══ */
  IF OBJECT_ID('dbo.usp_Ejemplo', 'P') IS NOT NULL
      DROP PROCEDURE dbo.usp_Ejemplo;
  GO
  CREATE PROCEDURE dbo.usp_Ejemplo ...
  GO
  ```
- Propiedad extendida re-creada (real, `build_ext_block`):
  ```sql
  EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'...',
      @level0type = N'SCHEMA',    @level0name = 'dbo',
      @level1type = N'PROCEDURE', @level1name = 'usp_Ejemplo';
  GO
  ```

---

## Secciones con información pendiente

- **06 QA:** estrategia de testing, cobertura mínima y qué no se testea (no hay tests).
- **07 Infra:** decisión sobre pipeline CI/CD (hoy inexistente).
- **08 Conventions:** modelo de branching, formato de commits y proceso de PR
  (historial de un solo commit, sin convención documentada).

El resto (01–05, 09) está completo a partir del código.

---

## Fuente de información

Inferido del codebase (Rust + frontend, `Cargo.toml`, `tauri.conf.json`, `README.md`)
y pendiente de confirmación del desarrollador en los puntos marcados `[pendiente]`.
La carpeta `docs/` fue **omitida** por instrucción explícita.
