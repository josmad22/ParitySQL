# Glossary

> Canonical domain vocabulary. Prefer these terms over synonyms in generated
> analyses, plans, specs, designs, and implementation notes.

## Terms

| Term | Definition | Aliases |
|---|---|---|
| Entorno | Configuración de conexión guardada (nombre, servidor, puerto, auth, usuario/contraseña, base por defecto, color). Persistida en `environments.json`. | environment, conexión |
| Objeto | Elemento de SQL Server a procesar: procedimiento, función, vista, trigger o tabla. Uno por línea; sin esquema asume `dbo`. | objeto SQL |
| Esquema | Prefijo `schema.objeto`. Si se omite, se asume `dbo`. | schema |
| Definición | Texto T-SQL del `CREATE` real, obtenido con `OBJECT_DEFINITION(object_id)`. | definition |
| Propiedad extendida | Metadato de `sys.extended_properties` (p. ej. `MS_Description`), re-creado tras el DROP/CREATE con `sp_addextendedproperty`. | extended property |
| Script generado | Cabecera `USE [db]; GO` + bloques `DROP`/`CREATE` por objeto, con banda `═` y numeración `Objeto i de N`. | resultado, script |
| Origen | Definición pegada o importada, tratada como versión propuesta para el entorno. | propuesta |
| Comparación | Diferencias locales entre la versión actual del entorno y la propuesta; incluye parámetros, cuerpo y alineación visual. | diff |
| Comando Tauri | Función Rust expuesta al frontend vía `invoke_handler` (p. ej. `generate_scripts`). | command, invoke |

## Relationships

How the main concepts relate to each other.

- Un **Entorno** apunta a un servidor SQL Server; de él se listan bases y se
  selecciona una para operar.
- Un **Objeto** pertenece a un **Esquema**; su **Definición** y **Propiedades
  extendidas** se leen del servidor y se combinan en el **Script generado**.
- Las acciones que leen SQL Server o escriben archivos invocan un **Comando Tauri**.
  El parsing, la comparación y la navegación de la interfaz son locales.

## Domain Rules

Business invariants the code must not violate.

- Sin esquema explícito, un objeto se resuelve contra `dbo`.
- Cada objeto generado incluye un `DROP` condicional antes de su definición.
- Las propiedades extendidas se re-crean después del DROP/CREATE, no antes.
- Objetos encriptados o del sistema (sin definición) se reportan como error, no
  abortan el lote.

## Excluded Terms

Informal or ambiguous terms that should not be used as canonical vocabulary.

| Informal term | Use instead |
|---|---|
| "conexión guardada" | Entorno |
| "SP" (a secas) | Objeto (procedimiento) |
