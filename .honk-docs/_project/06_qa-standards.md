# Estándares de QA

## Estrategia actual

| Tipo | Cobertura | Herramienta |
|---|---|---|
| Dominio de comparación | Parsing, errores por objeto, parámetros, dirección del diff, alineación, marcadores y codificaciones. | `node:test`, `tests/compare.test.js` |
| Backend unitario | Configuración vacía, reemplazo completo del JSON, detección de configuración inválida y limpieza ante fallo, puertos/instancias, límites de conexión y escritura de scripts. | Módulos Rust `#[cfg(test)]` |
| Actualizaciones | Estado desactivado, fuente segura, progreso, reintentos, descarga verificada antes de reinicio y recuperación de operaciones. | Rust y `tests/updates.test.js` |
| Contrato IPC | Campos `camelCase` consumidos por el frontend. | Pruebas Rust con `serde_json` |
| Interfaz | Extracción, selección de herramienta, importación, comparación, navegación y persistencia con IPC simulado. | Comprobaciones de navegador locales; no hay suite e2e versionada. |
| Integración SQL Server | Consultas y autenticación reales. | Requiere un servidor configurado por el usuario; no se sustituye por un mock ni se da por verificada sin ejecutarla. |

## Comandos desde la raíz

```powershell
node --test
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

## Reglas de regresión

- Probar cambios de lógica con casos que reproduzcan el defecto y sus límites.
- Mantener la firma y los campos de los comandos IPC cuando cambia su implementación.
- Verificar que el SQL pegado no se envía para ejecución y las consultas de objetos
  usan esquema/nombre separados como parámetros.
- Los fallos de un objeto no deben impedir revisar los demás.
- La configuración de una instalación nueva debe permanecer vacía.
- Las pruebas no requieren credenciales reales; usan datos sintéticos y temporales
  aislados. La prueba del servidor real es independiente y explícita.
- No se impone un porcentaje de cobertura aún. El workflow de releases ejecuta pruebas Node y Rust antes de publicar la release.
  No hay un workflow de PR; Clippy, formato y pruebas de navegador siguen siendo verificaciones locales.

La prueba explícita `published_update` descarga una release real, valida la firma,
rechaza bytes alterados y comprueba que solo se ofrece a versiones anteriores.
La instalación y reinicio completos se prueban con dos versiones empaquetadas. Las pruebas locales no ejecutan instaladores
ni reinician la aplicación del usuario.
