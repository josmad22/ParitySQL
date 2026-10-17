# Plan — Modo "Migración de datos con FK"

> Feature futura para **ParitySQL**. Genera un script `.sql` de inserción de datos
> desde una tabla raíz (con filtro), resolviendo automáticamente las dependencias por
> llave foránea hacia arriba, con **remapeo de PK** (no se preservan autoincrements) y
> guarda de existencia por **llave natural**. Salida = script; la ejecución en destino
> la hace el usuario (se mantiene la postura "generar, no ejecutar").

## 1. Decisiones fijadas (no re-discutir)

| Tema | Decisión |
|---|---|
| Dirección del grafo | **Solo padres** (hacia arriba: tablas que la raíz referencia) |
| Guarda de existencia | **`IF NOT EXISTS`** (no MERGE) |
| PK en destino | **No se preserva** → el destino asigna su identity → **remapeo de FK** |
| Volumen objetivo | **Pocos** (datos de referencia/config) → patrón variable-por-fila |
| Llave natural | **Auto**, "vinculada": buscar existente por llave → usar su PK; si no existe, usar la recién creada |
| Entornos | Espejos a nivel estructura (mismos nombres/columnas ambos lados) |

## 2. Idea maestra

La **PK de origen NUNCA se inserta**. Se usa solo de forma **interna** para:
1. Etiquetar variables `@Tabla_{pkOrigen}`.
2. Deduplicar filas dentro de una tabla.
3. Unir hijo → padre durante el recorrido.

El valor de FK escrito en destino sale del `@var` del padre (que contiene "el existente
si existe, el creado si no"). Así se remapea sin chocar con autoincrements.

## 3. Arquitectura

```
Frontend (nuevo modo)
  tabla raíz + WHERE  ──►  invoke("generate_data_migration", {conn, database, rootTable, filter, options})
                                        │
Backend (src-tauri/src/datamig.rs)      ▼
  1. introspect_table(root)         columnas, PK, identity, computed, rowversion
  2. run_root_select(filter)        SELECT * FROM root WHERE filter
  3. discover_fks(table)            sys.foreign_keys / foreign_key_columns
  4. transitive_closure()           traer filas padre por valor de FK (recursivo)
  5. topo_sort()                    padres antes que hijos (ciclo → error)
  6. resolve_natural_key(table)     regla auto determinista
  7. serialize()                    bloques buscar-o-insertar + threading de @vars
       ▼
  MigrationResult { header, script, counts[], warnings[] }
```

Reutiliza del código actual: `ConnConfig`, `connect()`, patrón de comando Tauri,
render con resaltador, copiar/descargar.

## 4. Modelo de datos interno (Rust)

```rust
struct ColumnMeta {
    name: String,
    sql_type: String,       // int, nvarchar, datetime2, ...
    max_len: i32,
    precision: u8,
    scale: u8,
    is_nullable: bool,
    is_identity: bool,
    is_computed: bool,
    is_rowversion: bool,    // rowversion/timestamp → nunca se inserta
}

struct FkRef {
    fk_name: String,
    fk_columns: Vec<String>,        // columnas en la tabla hija
    ref_schema: String,
    ref_table: String,
    ref_columns: Vec<String>,       // columnas referenciadas en el padre
}

struct TableMeta {
    schema: String,
    name: String,
    columns: Vec<ColumnMeta>,
    pk: Vec<String>,
    pk_is_identity: bool,
    natural_key: Vec<String>,       // resuelta por regla auto
    natural_key_source: String,     // "pk" | "unique:<idx>" | "fullrow"
    fks: Vec<FkRef>,
}

// clave interna de una fila de origen (identidad para grafo/dedup/vars)
struct RowId { table: String, pk: Vec<SqlValue> }

struct FetchedRow {
    id: RowId,
    values: Vec<(String, SqlValue)>,   // col -> valor tipado
}

enum SqlValue { Null, Int(i64), Dec(String), Bool(bool), Str(String),
                Date(String), Guid(String), Bytes(Vec<u8>), Float(f64) }

struct MigrationResult {
    header: String,                 // opcional: USE [db]
    script: String,
    counts: Vec<(String, usize)>,   // filas por tabla
    warnings: Vec<String>,
}
```

## 5. Queries de introspección

**Columnas + flags**
```sql
SELECT c.name, t.name AS sql_type, c.max_length, c.precision, c.scale,
       c.is_nullable, c.is_identity, c.is_computed,
       CASE WHEN t.name IN ('rowversion','timestamp') THEN 1 ELSE 0 END AS is_rowversion
FROM sys.columns c
JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID(@tabla)
ORDER BY c.column_id;
```

**PK + si es identity**
```sql
SELECT col.name, col.is_identity
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
JOIN sys.columns col ON col.object_id=i.object_id AND col.column_id=ic.column_id
WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(@tabla)
ORDER BY ic.key_ordinal;
```

**FK (hacia arriba)**
```sql
SELECT fk.name,
       OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS rs,
       OBJECT_NAME(fk.referenced_object_id)        AS rt,
       cpa.name  AS fk_col,
       cref.name AS ref_col,
       fkc.constraint_column_id AS ord
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns cpa  ON cpa.object_id=fk.parent_object_id      AND cpa.column_id=fkc.parent_column_id
JOIN sys.columns cref ON cref.object_id=fk.referenced_object_id AND cref.column_id=fkc.referenced_column_id
WHERE fk.parent_object_id = OBJECT_ID(@tabla)
ORDER BY fk.name, fkc.constraint_column_id;
```

**Índices UNIQUE candidatos a llave natural**
```sql
SELECT i.name AS idx, col.name AS col, ic.key_ordinal, col.is_nullable
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
JOIN sys.columns col ON col.object_id=i.object_id AND col.column_id=ic.column_id
WHERE i.is_unique = 1 AND i.is_primary_key = 0 AND i.object_id = OBJECT_ID(@tabla)
ORDER BY i.name, ic.key_ordinal;
```

**Traer filas padre** (por lote, por nivel)
```sql
SELECT * FROM {ref_schema}.{ref_table} WHERE {ref_col} IN ( <valores FK distintos> );
```

## 6. Regla auto de llave natural (determinista)

1. Si la **PK no es identity** → usar la PK.
2. Si no, tomar un **índice/constraint UNIQUE** sobre columnas NOT NULL → elegir el de
   **menos columnas**; desempate **alfabético** por nombre de índice.
3. Si no hay ninguno → **match por todas las columnas comparables** (excluye identity,
   computed, rowversion) + registrar **warning**.

Siempre se reporta `natural_key_source` por tabla para que el usuario lo vea.

## 7. Forma de la salida (contrato visual)

```sql
-- USE [db_destino];  (opcional, comentado por defecto)

-- ── TipoDoc (padre nivel 2) · llave: Codigo ──
DECLARE @TipoDoc_2 INT;
SELECT @TipoDoc_2 = Id_TipoDoc FROM dbo.TipoDoc WHERE Codigo = 'DNI';
IF @TipoDoc_2 IS NULL
BEGIN
    INSERT dbo.TipoDoc (Codigo, Nombre) VALUES ('DNI', N'DNI');
    SET @TipoDoc_2 = SCOPE_IDENTITY();
END

-- ── Persona (padre nivel 1) · llave: Nro_Documento ──
DECLARE @Persona_4021 INT;
SELECT @Persona_4021 = Id_Persona FROM dbo.Persona WHERE Nro_Documento = '19900398';
IF @Persona_4021 IS NULL
BEGIN
    INSERT dbo.Persona (Nombres, Nro_Documento, Id_TipoDoc)
    VALUES (N'Ana', '19900398', @TipoDoc_2);        -- FK remapeada
    SET @Persona_4021 = SCOPE_IDENTITY();
END

-- ── Afiliado (raíz) · llave: V_NUMERO_DOCUMENTO ──
IF NOT EXISTS (SELECT 1 FROM dbo.Afiliado WHERE V_NUMERO_DOCUMENTO = '19900398')
    INSERT dbo.Afiliado (V_NUMERO_DOCUMENTO, Id_Persona)
    VALUES ('19900398', @Persona_4021);             -- FK remapeada
GO
```

---

# 8. Fases

## Fase 0 — Spike de validación (medio día)
Confirmar el grafo real antes de escribir el motor.

- [ ] Elegir una tabla de `casilla_electronica` con FKs en QA.
- [ ] Correr `discover_fks` + closure a mano (example en `src-tauri/examples/`).
- [ ] Verificar: nº de niveles, tipos presentes, tablas sin llave natural, ciclos.
- [ ] Documentar hallazgos (ajustan alcance de F1).

**Aceptación:** dado el árbol de FK impreso, se confirma que el grafo es finito y que
las tablas involucradas tienen llave natural (o se listan las que no).

## Fase 1 — MVP núcleo (entrega el 70% del valor)
Cierre transitivo + topo + tipos comunes + llave auto + remap por `@var` + `IF NOT EXISTS`.

**Backend**
- [ ] `datamig.rs`: `introspect_table`, `discover_fks`, `resolve_natural_key` (reglas 1–3).
- [ ] `run_root_select(root, filter)` → filas raíz tipadas.
- [ ] `transitive_closure()` (FK de **una columna**, valores no nulos, dedup por PK origen).
- [ ] `topo_sort()` (Kahn); **ciclo → Err con mensaje claro**.
- [ ] `SqlValue` + `sql_literal()` para tipos comunes: `int/bigint/smallint/tinyint`,
      `decimal/numeric/money`, `bit`, `varchar/nvarchar/char/nchar`, `date/datetime/datetime2`,
      `uniqueidentifier`, `NULL`.
- [ ] `serialize()`: bloques padre (DECLARE+SELECT+IF+INSERT+SCOPE_IDENTITY) y raíz (`IF NOT EXISTS`).
- [ ] Comando `generate_data_migration` + registro en `invoke_handler`.
- [ ] Saltar columnas identity/computed/rowversion en el INSERT.

**Frontend**
- [ ] Toggle de modo: "Objetos" | "Migración".
- [ ] Campos: tabla raíz + textarea WHERE. Reusa conexión/BD activas.
- [ ] Botón "Generar migración"; salida en el panel derecho (resaltador, copiar, descargar).
- [ ] Mostrar `warnings` y `counts` sobre el resultado.

**Fuera de alcance F1:** FK compuesta, FK a columna UNIQUE no-PK, ciclos, huérfanos avanzados, triggers.

**Aceptación (GWT)**
- *Dado* una tabla raíz con 1–2 niveles de FK de una columna y filtro que devuelve pocas filas,
  *cuando* genero, *entonces* el script inserta padres antes que hijos, remapea FKs vía `@var`,
  y cada bloque tiene su guarda (`IF NULL` / `IF NOT EXISTS`).
- *Dado* un ciclo de FK, *cuando* genero, *entonces* recibo un error explícito (no un script roto).
- *Dado* que ejecuto el script dos veces en destino, *entonces* no se duplican filas.

## Fase 2 — Cobertura
- [ ] **FK compuesta**: match por todas las columnas (`WHERE a=.. AND b=..`), variables por fila.
- [ ] **FK → columna UNIQUE no-PK**: usar `ref_columns` reales en el lookup.
- [ ] **Huérfanos**: valor de FK sin fila padre en origen → warning + omitir esa rama.
- [ ] **Cobertura de tipos completa**: `float/real` (round-trip), `varbinary/binary` (`0x..`),
      `time`, `datetimeoffset`, `xml` (como `N'..'`), `sql_variant` (best-effort + warning).
- [ ] **Preview**: endpoint que devuelve solo `counts` por tabla; UI pide confirmación antes de generar.
- [ ] **Selección de llave natural visible**: mostrar por tabla qué llave usó; permitir override manual.

**Aceptación**
- *Dado* una tabla con FK compuesta, *entonces* el lookup usa todas las columnas y el remapeo es correcto.
- *Dado* un valor de FK huérfano, *entonces* aparece en `warnings` y el script sigue siendo válido.
- *Dado* el preview, *entonces* veo el conteo por tabla antes de generar el script completo.

## Fase 3 — Robustez y escala
- [ ] **Ciclos / auto-referencia**: estrategia INSERT con FK NULL + `UPDATE` posterior (2 pasadas);
      ordenar filas intra-tabla por profundidad de auto-referencia.
- [ ] **Disable/enable triggers**: opción para envolver con `DISABLE TRIGGER ALL ON t` / `ENABLE`.
- [ ] **Modo volumen** (`#map` temp): cuando el conteo supere un umbral, cambiar de variable-por-fila
      a **tabla temporal de mapeo** (`#map_{tabla}(src,tgt)`) con inserts set-based + remap por JOIN.
- [ ] **Límite de profundidad/tamaño** configurable + aviso de truncación (nada silencioso).

**Aceptación**
- *Dado* una tabla con auto-referencia, *entonces* el script inserta en 2 pasadas sin violar FK.
- *Dado* un conteo alto, *entonces* el generador usa `#map` y el script no declara miles de variables.

## Fase 4 — Calidad y empaquetado
- [ ] Tests: `examples/datamig_probe.rs` contra QA (varios escenarios: 1 nivel, N niveles,
      compuesta, huérfano, ciclo).
- [ ] Manejo de errores homogéneo (mensajes en español, accionables).
- [ ] Sección en `README.md` + este plan enlazado.
- [ ] Revisar seguridad: el WHERE es del propio usuario sobre su DB (dev tool) — documentar que
      no se sanitiza y por qué es aceptable.

---

# 9. Riesgos y mitigaciones (consolidado)

| Riesgo | Fase | Mitigación |
|---|---|---|
| Explosión del cierre transitivo | F2 | preview de conteo + límite de profundidad |
| Tabla sin llave natural | F1 | fallback full-row + warning |
| Ciclo de FK | F1/F3 | F1: error claro. F3: NULL+UPDATE |
| Miles de variables (no escala) | F3 | modo `#map` temp por umbral |
| Tipos raros mal serializados | F2 | cobertura incremental + warning en `sql_variant` |
| Triggers en destino con side-effects | F3 | opción disable triggers |
| Dependencias lógicas sin FK declarada | — | documentar límite: solo FK reales |

# 10. Definición de "terminado" por fase

- **F1:** genera script correcto para el caso típico (pocos niveles, 1 col FK), idempotente,
  ciclo = error. Probado contra QA con al menos 2 tablas reales.
- **F2:** cubre FK compuesta/unique + huérfanos + preview; tipos completos.
- **F3:** soporta ciclos y volumen; opción triggers.
- **F4:** tests + docs + errores pulidos.

# 11. Archivos afectados (previsión)

```
src-tauri/src/datamig.rs        (nuevo) — motor de migración
src-tauri/src/lib.rs            + comando generate_data_migration
src-tauri/examples/datamig_probe.rs (nuevo) — validación end-to-end
src/index.html                 + toggle de modo + campos tabla/WHERE
src/styles.css                 + estilos del modo
src/main.js                    + lógica del modo y render
docs/PLAN_migracion_datos_fk.md (este archivo)
```
