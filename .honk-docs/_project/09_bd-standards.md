# Database Standards

> Standards for designing and creating database objects. Any skill that creates
> or alters database objects must treat these rules as project constraints —
> `honk-fast-apply` reads this doc directly when emitting DB scripts. The
> `Examples` block holds real snippets sourced from the codebase — never invented.

> **Punto clave:** esta app **no administra un esquema de base de datos propio**. No
> crea tablas, no versiona una BD, no usa migraciones. Interactúa con SQL Server de
> dos formas: (a) consultas de **solo lectura** a vistas de sistema, y (b) generación
> de **T-SQL de salida**. Los estándares siguientes describen ese T-SQL generado y
> las convenciones observadas en el código.

## Engine and Schemas

**Engine:** SQL Server (T-SQL), vía driver `tiberius` 0.12.

| Schema | Purpose | Owner |
|---|---|---|
| `dbo` | Esquema por defecto asumido cuando el objeto no lo especifica. | SQL Server |

## Naming Conventions

| Object | Convention | Example |
|---|---|---|
| Tables | N/A — la app no crea tablas propias. | — |
| Columns | N/A | — |
| Primary keys | N/A | — |
| Foreign keys | N/A | — |
| Indexes | N/A | — |
| Unique constraints | N/A | — |
| Check constraints | N/A | — |
| Views | Calificado `esquema.objeto`; sin esquema → `dbo`. | `dbo.v_Ejemplo` |
| Stored procedures / Functions | Calificado `esquema.objeto`; sin esquema → `dbo`. | `dbo.usp_Ejemplo` |

## Data Types

- N/A — la app no define columnas.
- En consultas de sistema usa `CAST(... AS NVARCHAR(MAX))` para leer valores de
  propiedades extendidas.

## Keys and Constraints

- N/A — no se crean objetos propios.

## Indexes

- N/A.

## Standard Columns

| Column | Type | Rule |
|---|---|---|
| — | — | N/A. |

## Migrations

**Tooling:** Ninguna — no aplica. La única persistencia es un archivo JSON, no un
esquema versionado.

- N/A.

## Script Organization

> How hand-authored database objects are grouped into files.

**Schema authoring:** `no_aplica`  <!-- la app no administra esquema; genera scripts en runtime -->

**Script file extension:** `.sql`

- No hay carpeta `bd_scripts/` propia. Los scripts son **generados en runtime** por
  el backend y exportados por el usuario como `.sql` vía el diálogo de guardado.
- El formato de cada bloque generado (banda, DROP condicional, CREATE, propiedades
  extendidas) es el estándar canónico — ver **Examples**.

## Required

- Cada objeto generado incluye `IF OBJECT_ID(...) IS NOT NULL` y su `DROP`
  antes de la definición recuperada del servidor.
- Las propiedades extendidas se re-crean **después** del DROP/CREATE.
- Cabecera `USE [db]; GO` al inicio del script completo.

## Forbidden

- Inventar o alterar la definición del objeto: siempre proviene de
  `OBJECT_DEFINITION` en el servidor.
- Ejecutar desde la aplicación el SQL generado o las definiciones pegadas/importadas.
- Emitir un `DROP` sin la comprobación condicional `IF OBJECT_ID(...) IS NOT NULL`.

## Examples

> Snippets reales extraídos del codebase (`src-tauri/src/sql.rs`). Nunca inventados.

### Create table

```sql
-- N/A: la app no crea tablas propias. [no aplica]
```

### Insert

```sql
-- N/A: la app no escribe datos en SQL Server. [no aplica]
```

### Stored procedure / Function

```sql
-- Bloque DROP/CREATE generado (formato real de build_block):
/* ═══ Objeto 1 de N · dbo.usp_Ejemplo (procedimiento) ═══ */
IF OBJECT_ID('dbo.usp_Ejemplo', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_Ejemplo;
GO
CREATE PROCEDURE dbo.usp_Ejemplo ...
GO
-- Propiedad extendida re-creada (formato real de build_ext_block):
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'...',
    @level0type = N'SCHEMA',    @level0name = 'dbo',
    @level1type = N'PROCEDURE', @level1name = 'usp_Ejemplo';
GO
```

### Create index

```sql
-- N/A: la app no crea índices. [no aplica]
```

### Migration (up / down)

```sql
-- N/A: sin migraciones. [no aplica]

-- Consultas de metadatos reales usadas por la app (solo lectura):
SELECT o.type, OBJECT_DEFINITION(o.object_id)
FROM sys.objects o WHERE o.object_id = OBJECT_ID(@P1);

SELECT name FROM sys.databases
WHERE state = 0 AND name NOT IN ('master','tempdb','model','msdb')
ORDER BY name;
```
