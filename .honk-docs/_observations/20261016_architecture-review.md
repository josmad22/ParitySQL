# Revisión de arquitectura — 2026-10-16

## Alcance

Contraste del código de ParitySQL con los nueve documentos de `_project`, revisión
de las fronteras frontend/backend y corrección de las desviaciones encontradas.
Se conservaron la arquitectura de dos capas, el frontend sin bundler y los nombres,
argumentos y respuestas correctas de los comandos IPC.

| Regla | Resultado |
|---|---|
| UI separada de SQL Server | Conforme: toda consulta al motor pasa por Rust. |
| SQL pegado/importado sin ejecución | Conforme: parsing y comparación locales; consulta de definiciones por esquema/nombre parametrizados. |
| Dominio de comparación independiente de UI e infraestructura | Conforme: `compare.js` no depende del DOM, IPC ni persistencia. |
| Adaptadores IPC delegan en módulos | Corregido: la exportación pertenece a `files.rs`. |
| E/S de archivos fuera del hilo de UI | Corregido: configuración con `spawn_blocking` y exportación con `tokio::fs`. |
| Guardados consistentes | Corregido: instantáneas en cola, temporal sincronizado y reemplazo completo del JSON; no se informa éxito cuando falla y un JSON inválido se reporta sin borrarlo. |
| Formatos de conexión documentados | Corregido: `HOST,puerto` conserva el puerto explícito; se comprueban límites inválidos antes de abrir la conexión. |
| Serialización `camelCase` | Conforme y cubierta por pruebas de contrato. |
| Errores por objeto y definición original | Conservados; pruebas de script, propiedades y comparación. |
| Distribución sin conexiones precargadas | Conforme y cubierta por prueba. |
| Rustfmt y dependencias directas | Corregido el formato y retirada una dependencia directa sin uso (`futures-util`, que puede seguir siendo transitiva). |
| Documentación coherente | Actualizada para reflejar módulos, contratos, pruebas y límites vigentes. |

## Validaciones

- Ocho pruebas Rust: puertos/instancias, validación previa a red, preservación de
  definición/propiedades, persistencia, exportación y contrato IPC.
- Veintitrés pruebas Node: parsing, parámetros, codificación, diferencias y alineación.
- Clippy con advertencias como errores, comprobación de rustfmt y sintaxis JavaScript.
- Navegador con IPC simulado: guardados en orden, fallo/reintento, extracción por
  objeto, portapapeles, exportación y conexión compartida entre herramientas.
- Regresiones de comparación: filas alineadas, hover, marcadores, rueda/teclado,
  arrastre del scroll, cambio de objeto, edición y contenido largo.

## Límites de esta revisión

No se ejecutaron consultas en un SQL Server real: la configuración permanece
vacía y las comprobaciones de interfaz simulan el IPC. No hay una suite e2e
versionada ni CI configurada.

Esta revisión no cambia las decisiones existentes de guardar contraseñas locales
en texto plano, confiar en certificados del servidor y mantener la CSP sin
configurar. Están documentadas en arquitectura; no se declara un endurecimiento
completo de seguridad.
