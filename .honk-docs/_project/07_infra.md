# Infra

> Infrastructure and operations context for deploy, environments, secrets, and
> observability decisions.

> **Nota:** aplicación de escritorio de distribución única. No hay ambientes de
> servidor (dev/staging/prod). Los "entornos" del producto son conexiones SQL
> Server del usuario, no ambientes de despliegue.

## Environments

| Environment | Purpose | URL or endpoint |
|---|---|---|
| development | Ejecución local con `cargo tauri dev`. | N/A (escritorio) |
| staging | N/A — no aplica a app de escritorio. | N/A |
| production | Instalador distribuido al usuario final. | N/A |

## Platform

**Cloud provider:** Ninguno.

**Runtime platform:** Windows 11 (WebView2 + binario nativo).

**Services:**

| Service | Provider or tool | Purpose |
|---|---|---|
| SQL Server | Servidor del usuario | Fuente de metadatos (externo, no provisto). |

## CI/CD

**Pipeline:** `.github/workflows/release.yml` prepara releases Windows NSIS en
borrador al crear una etiqueta de versión. Requiere la variable pública
`PARITYSQL_UPDATER_PUBLIC_KEY` y los secretos de firma de Tauri; inicialmente no
están configurados. No se han publicado releases ni configurado un repositorio.
Detalles en `docs/UPDATES.md`.

```text
Build manual:
  cargo tauri build  ->  src-tauri/target/release/bundle/{nsis,msi}
```

**Secretos de publicación:** `TAURI_SIGNING_PRIVATE_KEY` y, si se utiliza,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, disponibles únicamente en los pasos de
validación/firma. Nunca se incorporan al binario ni al repositorio.

## Environment Variables

| Variable | dev | staging | prod | Description |
|---|---|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Solo firma local | N/A | GitHub Secret para compilar | Clave privada; nunca se distribuye. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Solo firma local | N/A | GitHub Secret para compilar | Contraseña opcional de la clave. |
| `PARITYSQL_UPDATER_PUBLIC_KEY` | Configuración pública | N/A | GitHub Variable para compilar | Contenido `.pub`, se incluye en el instalador. |

## Containers

**Container:** N/A.

**Orchestration:** N/A.

**Registry:** N/A.

## Observability

| Tool | Purpose |
|---|---|
| N/A | App de escritorio; sin telemetría ni logging centralizado. |

## Backups and Disaster Recovery

- La configuración de usuario (`environments.json`) vive en
  `%APPDATA%/com.sphelper.sqlhelptext/`. No hay respaldo automático. Los guardados reemplazan el archivo solo después
  de completar y sincronizar la escritura temporal en el mismo directorio.
- **Seguridad:** las contraseñas de entorno se guardan en **texto plano** en ese
  JSON (uso interno). Mejora sugerida: Windows Credential Manager.
