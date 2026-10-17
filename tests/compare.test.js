const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyzeSources, parseModules, compareDefinitions, diffLines, alignLines, decodeSql } = require("../src/compare.js");

test("recupera varios módulos sin GO, como en la referencia", () => {
  const modules = parseModules("CREATE PROCEDURE dbo.sp_Clientes @Id INT AS SELECT @Id;\nCREATE FUNCTION dbo.fn_Monto(@n INT) RETURNS INT AS BEGIN RETURN @n END");
  assert.deepEqual(modules.map(({ schema, name, kind }) => ({ schema, name, kind })), [
    { schema: "dbo", name: "sp_Clientes", kind: "PROCEDURE" },
    { schema: "dbo", name: "fn_Monto", kind: "FUNCTION" },
  ]);
  assert.ok(!modules[0].definition.includes("CREATE FUNCTION"));
});

test("ignora declaraciones y GO dentro de comentarios y cadenas", () => {
  const [item] = parseModules(`/* CREATE PROC falso AS SELECT 1; /* anidado */ */
USE prueba;
GO
CREATE OR ALTER PROC [ventas].[Mi]]SP]
AS
SELECT 'CREATE PROC falso AS SELECT 1;
GO
ALTER FUNCTION dbo.f() RETURNS INT AS RETURN 1';
GO -- separador
SET ANSI_NULLS ON;
GO`);
  assert.equal(item.schema, "ventas");
  assert.equal(item.name, "Mi]SP");
  assert.ok(!item.definition.includes("SET ANSI_NULLS"));
  assert.ok(item.definition.includes("ALTER FUNCTION dbo.f"));
});

test("admite nombres citados, puntos en identificadores y nombres Unicode", () => {
  const [item] = parseModules('ALTER FUNCTION "área.ventas"."Cálculo"() RETURNS INT AS BEGIN RETURN 1 END');
  assert.equal(item.schema, "área.ventas");
  assert.equal(item.name, "Cálculo");
  assert.equal(parseModules("CREATE PROC MiSP AS SELECT 1")[0].schema, "dbo");
});

test("valida entradas vacías, declaraciones incompletas y duplicados", () => {
  assert.throws(() => parseModules("SELECT 1"), /al menos un/);
  assert.throws(() => parseModules("CREATE PROC dbo.incompleto @id INT"), /Falta AS/);
  assert.throws(() => parseModules("CREATE PROC uno AS SELECT 1\nGO\nALTER PROC dbo.uno AS SELECT 2"), /repetido/);
  assert.throws(() => parseModules("CREATE PROC otra.dbo.uno AS SELECT 1"), /esquema.objeto/);
});

test("CREATE, ALTER, PROC y corchetes equivalentes no producen cambios", () => {
  const result = compareDefinitions("CREATE OR ALTER PROC [dbo].[uno] @id INT\r\nAS\r\nSELECT @id", "ALTER PROCEDURE dbo.uno @id INT\nAS\nSELECT @id");
  assert.equal(result.label, "Sin cambios");
  assert.ok(result.lines.every((line) => line.type === "equal"));
});

test("distingue parámetros y cuerpo, incluido EXECUTE AS y AS en cadenas", () => {
  const original = "CREATE PROC dbo.p @id INT WITH EXECUTE AS OWNER\nAS\nSELECT 'AS', @id";
  const parameter = original.replace("@id INT", "@id BIGINT");
  const body = original.replace("SELECT 'AS', @id", "SELECT 'AS', @id + 1");
  assert.equal(compareDefinitions(original, parameter).label, "Parámetros modificados");
  assert.equal(compareDefinitions(original, body).label, "Cuerpo modificado");
  assert.equal(compareDefinitions(original, body.replace("@id INT", "@id BIGINT")).label, "Parámetros modificados + Cuerpo modificado");
});

test("la dirección del diff va de origen a entorno", () => {
  const lines = diffLines("uno\ndos\ntres", "uno\nDOS\ntres\ncuatro");
  assert.deepEqual(lines.filter((l) => l.type === "removed").map((l) => l.text), ["dos"]);
  assert.deepEqual(lines.filter((l) => l.type === "added").map((l) => l.text), ["DOS", "cuatro"]);
  assert.deepEqual(lines.filter((l) => l.type !== "removed").map((l) => l.number), [1, 2, 3, 4]);
});

test("admite funciones inline sin AS y AS opcional en tipos de parámetros", () => {
  const fn = "CREATE FUNCTION dbo.f(@id INT) RETURNS TABLE RETURN (SELECT @id AS Id)";
  assert.equal(parseModules(fn).length, 1);
  assert.equal(compareDefinitions(fn, fn.replace("SELECT @id", "SELECT @id + 1")).label, "Cuerpo modificado");
  const proc = "CREATE PROC dbo.p @id AS INT AS SELECT @id";
  assert.equal(compareDefinitions(proc, proc.replace("AS INT", "AS BIGINT")).label, "Parámetros modificados");
});

test("scripts extensos conservan cada línea al limitar la memoria del diff", () => {
  const a = Array.from({ length: 1600 }, (_, i) => "origen " + i).join("\n");
  const b = Array.from({ length: 1600 }, (_, i) => "entorno " + i).join("\n");
  const lines = diffLines(a, b);
  assert.equal(lines.filter((l) => l.type !== "added").map((l) => l.text).join("\n"), a);
  assert.equal(lines.filter((l) => l.type !== "removed").map((l) => l.text).join("\n"), b);
});

test("inserciones y eliminaciones al inicio y al final no pierden contexto", () => {
  for (const [a, b] of [["A\nB", "X\nA\nB\nY"], ["X\nA\nB\nY", "A\nB"], ["A\nB", "A\nB"], ["A", "B"]]) {
    const lines = diffLines(a, b);
    assert.equal(lines.filter((l) => l.type !== "added").map((l) => l.text).join("\n"), a);
    assert.equal(lines.filter((l) => l.type !== "removed").map((l) => l.text).join("\n"), b);
  }
});

test("filtra wrappers de SSMS y conserva SET, DROP, comentarios y cadenas dentro del SP", () => {
  const definition = `CREATE OR ALTER PROC dbo.p @n INT AS
BEGIN
  SET NOCOUNT ON;
  -- CREATE PROC dbo.falso AS SELECT 1
  IF OBJECT_ID('tempdb..#t') IS NOT NULL DROP TABLE #t;
  SELECT 'GO', CASE WHEN @n = 0 THEN 'ALTER FUNCTION' ELSE 'CREATE PROC' END;
END;`;
  const exportSql = `USE [otra_base]\nGO\nSET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\nIF OBJECT_ID('dbo.p') IS NOT NULL DROP PROC dbo.p;\nGO\n${definition}\nGO\nEXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'prueba';\nGO`;
  const [item] = parseModules(exportSql);
  assert.equal(item.definition, definition);
  assert.equal(item.name, "p");
});

test("los errores y duplicados de un archivo no impiden procesar otros", () => {
  const result = analyzeSources([
    { id: "a", name: "uno.sql", content: "CREATE PROC dbo.repetido AS SELECT 1\nGO\nCREATE PROC dbo.incompleto AS BEGIN SELECT 1" },
    { id: "b", name: "dos.sql", content: "ALTER PROC dbo.repetido AS SELECT 2\nGO\nCREATE FUNCTION ventas.total(@n INT) RETURNS INT AS BEGIN RETURN @n END" },
    { id: "c", name: "sin-modulos.sql", content: "SELECT 1; EXEC dbo.referencia;" },
    { id: "d", name: "ilegible.sql", error: "No se pudo leer el archivo." },
  ]);
  assert.equal(result.modules.length, 4);
  assert.equal(result.modules.filter((m) => m.status === "duplicate").length, 2);
  assert.match(result.modules.find((m) => m.name === "incompleto").error, /Falta END/);
  const valid = result.modules.filter((m) => !m.error);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].source, "dos.sql");
  assert.equal(valid[0].line, 3);
  assert.equal(result.issues.length, 2);
});

test("una cadena o comentario sin cerrar invalida solo su objeto", () => {
  for (const broken of ["SELECT 'sin cerrar", "SELECT 1 /* sin cerrar", "SELECT (1", "BEGIN SELECT 1"]) {
    const result = analyzeSources([{ id: "x", name: "prueba.sql", content: "CREATE PROC dbo.valido AS SELECT 1\nGO\nCREATE PROC dbo.roto AS " + broken }]);
    assert.equal(result.modules.length, 2);
    assert.equal(result.modules[0].error, "");
    assert.ok(result.modules[1].error);
  }
});

test("las transacciones y CASE no se confunden con bloques BEGIN/END", () => {
  assert.equal(parseModules("CREATE PROC p AS BEGIN BEGIN TRANSACTION; SELECT CASE WHEN 1=1 THEN 2 END; COMMIT; END")[0].error, "");
});

test("los cambios de parámetros distinguen altas, bajas, default, tamaño y OUTPUT", () => {
  const before = "CREATE PROC dbo.p @id INT, @nombre VARCHAR(20) = 'A', @viejo INT AS SELECT 1";
  const after = "ALTER PROC dbo.p @id INT OUTPUT, @nombre VARCHAR(50) = 'a', @nuevo BIT = 0 AS SELECT 1";
  const result = compareDefinitions(after, before);
  assert.deepEqual(result.parameterChanges.map((p) => [p.name, p.change]), [
    ["@id", "Modificado"], ["@nombre", "Modificado"], ["@viejo", "Eliminado"], ["@nuevo", "Agregado"],
  ]);
  assert.equal(result.label, "Parámetros modificados");
  assert.match(result.parameterChanges[1].source, /VARCHAR\(50\)/);
  assert.match(result.parameterChanges[1].target, /VARCHAR\(20\)/);
});

test("compara orden, tablas de retorno, DECIMAL y tipos con esquema", () => {
  const before = "CREATE FUNCTION dbo.f(@a DECIMAL(18,2), @b dbo.MiTipo) RETURNS TABLE AS RETURN (SELECT @a AS Total)";
  const after = "CREATE FUNCTION dbo.f(@b dbo.MiTipo, @a DECIMAL(18,2)) RETURNS @r TABLE(Total DECIMAL(18,2)) AS RETURN (SELECT @a AS Total)";
  const result = compareDefinitions(before, after);
  assert.equal(result.parameterChanges.length, 2);
  assert.ok(result.parameterChanges.every((p) => p.change === "Orden modificado"));
  assert.equal(result.returnsChanged, true);
  assert.match(result.label, /Retorno modificado/);
});

test("cambios de opciones y formato no se etiquetan como parámetros", () => {
  const before = "CREATE PROC dbo.p @n AS INT OUT WITH EXECUTE AS OWNER AS SELECT @n";
  const after = "CREATE PROC dbo.p @n INT OUTPUT WITH EXECUTE AS CALLER AS SELECT @n";
  const result = compareDefinitions(before, after);
  assert.equal(result.parameterChanges.length, 0);
  assert.equal(result.label, "Opciones modificadas");
  const formatted = compareDefinitions("CREATE PROC p @n INT AS SELECT 1", "ALTER PROC p\n @n   int\nAS SELECT 1");
  assert.equal(formatted.parameterChanges.length, 0);
  assert.equal(formatted.label, "Formato o comentarios modificados");
});

test("decodifica UTF-8, UTF-16 LE/BE de SSMS y Windows-1252", () => {
  const sql = "CREATE PROC dbo.prueba AS SELECT N'José'";
  assert.equal(decodeSql(new TextEncoder().encode(sql)), sql);
  const little = Buffer.from(sql, "utf16le");
  assert.equal(decodeSql(Buffer.concat([Buffer.from([255, 254]), little])), sql);
  assert.equal(decodeSql(little), sql);
  const big = Buffer.from(little).swap16();
  assert.equal(decodeSql(Buffer.concat([Buffer.from([254, 255]), big])), sql);
  assert.equal(decodeSql(Buffer.from(sql, "latin1")), sql);
  assert.throws(() => decodeSql(Uint8Array.from([255, 254, 65])), /UTF-16 incompleta/);
  assert.throws(() => decodeSql(Uint8Array.from([0, 0, 0, 0, 0, 0])), /texto SQL/);
});

test("inserciones y eliminaciones dejan huecos y realinean las líneas coincidentes", () => {
  const rows = alignLines("inicio\neliminado1\neliminado2\ncomún1\ncomún2\nfin", "inicio\ncomún1\nagregado1\nagregado2\ncomún2\nfin");
  for (const anchor of ["inicio", "común1", "común2", "fin"]) {
    const row = rows.find((r) => r.left && r.left.text === anchor);
    assert.equal(row.right.text, anchor);
  }
  assert.equal(rows.filter((r) => !r.left).length, 2);
  assert.equal(rows.filter((r) => !r.right).length, 2);
  assert.deepEqual(rows.find((r) => r.left && r.left.text === "común1"), {
    left: { type: "equal", text: "común1", number: 4 },
    right: { type: "equal", text: "común1", number: 2 },
  });
});

test("los bloques reemplazados conservan el texto y la numeración de cada versión", () => {
  const cases = [
    ["A\nviejo\nZ", "A\nnuevo1\nnuevo2\nZ"],
    ["viejo1\nviejo2\nfin", "nuevo\nfin"],
    ["A\nB", "A\nB"],
    ["A", "B"],
    [Array.from({ length: 1500 }, (_, i) => "a" + i).join("\n"), Array.from({ length: 1500 }, (_, i) => "b" + i).join("\n")],
  ];
  for (const [left, right] of cases) {
    const rows = alignLines(left, right);
    for (const [side, original] of [["left", left], ["right", right]]) {
      const lines = rows.map((r) => r[side]).filter(Boolean);
      assert.equal(lines.map((l) => l.text).join("\n"), original);
      assert.deepEqual(lines.map((l) => l.number), lines.map((_, i) => i + 1));
    }
  }
});

test("la alineación conserva declaraciones equivalentes sin colorearlas como cambios", () => {
  const left = "CREATE OR ALTER PROC [dbo].[p] @n INT\nAS\nSELECT @n";
  const right = "ALTER PROCEDURE dbo.p @n INT\nAS\nSELECT @n";
  const result = compareDefinitions(left, right);
  assert.equal(result.same, true);
  assert.equal(result.alignedRows.map((r) => r.left).filter(Boolean).map((l) => l.text).join("\n"), left);
  assert.equal(result.alignedRows.map((r) => r.right).filter(Boolean).map((l) => l.text).join("\n"), right);
  assert.ok(result.alignedRows.every((r) => (!r.left || r.left.type === "equal") && (!r.right || r.right.type === "equal")));
});

test("el entorno es la base y el origen propone altas, bajas y reemplazos", () => {
  const proposal = "CREATE PROC dbo.p AS\nBEGIN\nSELECT 10 AS Agregado;\nSELECT 1 AS Ancla;\nSELECT 2 AS Ancla;\nSELECT 30 AS Propuesto;\nSELECT 4 AS Ancla;\nEND";
  const current = "CREATE PROC dbo.p AS\nBEGIN\nSELECT 1 AS Ancla;\nSELECT 20 AS Quitado;\nSELECT 2 AS Ancla;\nSELECT 300 AS Actual;\nSELECT 4 AS Ancla;\nEND";
  const result = compareDefinitions(proposal, current);
  assert.deepEqual(result.changes.map((c) => c.type), ["added", "removed", "modified"]);
  assert.ok(result.alignedRows.some((r) => r.left && r.left.type === "added" && r.left.text.includes("10 AS Agregado") && !r.right));
  assert.ok(result.alignedRows.some((r) => !r.left && r.right && r.right.type === "removed" && r.right.text.includes("20 AS Quitado")));
  const replacement = result.alignedRows.find((r) => r.left && r.left.text.includes("30 AS Propuesto"));
  assert.equal(replacement.left.type, "added");
  assert.equal(replacement.right.type, "removed");
  assert.match(replacement.right.text, /300 AS Actual/);
  assert.ok(result.lines.filter((l) => l.type === "added").every((l) => proposal.includes(l.text)));
  assert.ok(result.lines.filter((l) => l.type === "removed").every((l) => current.includes(l.text)));
  for (const [side, original] of [["left", proposal], ["right", current]]) {
    assert.equal(result.alignedRows.map((r) => r[side]).filter(Boolean).map((l) => l.text).join("\n"), original);
  }
});

test("los marcadores agrupan cambios consecutivos y conservan referencias reales", () => {
  const result = compareDefinitions("CREATE PROC p AS\nSELECT 1;\nSELECT 2;\nSELECT 3;\nSELECT 4;", "CREATE PROC p AS\nSELECT 3;");
  assert.equal(result.changes.length, 2);
  assert.equal(result.changes[0].type, "added");
  assert.equal(result.changes[0].sourceLine, 2);
  assert.equal(result.changes[0].targetLine, null);
  assert.equal(result.changes[0].end - result.changes[0].start, 1);
  assert.equal(result.changes[1].sourceLine, 5);
  assert.deepEqual(compareDefinitions("CREATE PROC p AS SELECT 1", "ALTER PROC p AS SELECT 1").changes, []);
});
