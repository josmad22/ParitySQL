// Parsing y comparación locales. El SQL pegado nunca se ejecuta.
(function (root) {
  // Conserva posiciones e ignora comentarios para reconocer declaraciones reales,
  // incluso si las cadenas contienen CREATE, AS o separadores GO.
  function tokenize(sql) {
    const tokens = [];
    let i = 0;
    while (i < sql.length) {
      const start = i;
      const c = sql[i];
      if (/\s/.test(c)) { i++; continue; }
      if (sql.startsWith("--", i)) {
        while (i < sql.length && sql[i] !== "\n") i++;
        continue;
      }
      if (sql.startsWith("/*", i)) {
        let depth = 1;
        i += 2;
        while (i < sql.length && depth) {
          if (sql.startsWith("/*", i)) { depth++; i += 2; }
          else if (sql.startsWith("*/", i)) { depth--; i += 2; }
          else i++;
        }
        if (depth) tokens.lexicalError = { start, message: "Comentario sin cerrar." };
        continue;
      }
      if (c === "'" || c === '"' || c === "[") {
        const close = c === "[" ? "]" : c;
        let closed = false;
        i++;
        while (i < sql.length) {
          if (sql[i++] === close) {
            if (sql[i] === close) i++;
            else { closed = true; break; }
          }
        }
        const raw = sql.slice(start, i);
        if (!closed) tokens.lexicalError = { start, message: "Cadena o identificador sin cerrar." };
        tokens.push({ value: raw, start, end: i, type: c === "'" ? "string" : "identifier" });
        continue;
      }
      if (/[\p{L}\p{N}_@#$]/u.test(c)) {
        while (i < sql.length && /[\p{L}\p{N}_@#$]/u.test(sql[i])) i++;
        tokens.push({ value: sql.slice(start, i), start, end: i, type: "word" });
      } else {
        tokens.push({ value: c, start, end: ++i, type: "symbol" });
      }
    }
    return tokens;
  }

  function isWord(token, word) {
    return token && token.type === "word" && token.value.toUpperCase() === word;
  }
  function identifier(token) {
    if (!token || !["word", "identifier"].includes(token.type)) return null;
    if (token.type === "word") return token.value;
    return token.value[0] === "["
      ? token.value.slice(1, -1).replace(/\]\]/g, "]")
      : token.value.slice(1, -1).replace(/""/g, '"');
  }
  function declaration(tokens, i) {
    if (!isWord(tokens[i], "CREATE") && !isWord(tokens[i], "ALTER")) return null;
    let k = i + 1;
    if (isWord(tokens[i], "CREATE") && isWord(tokens[k], "OR") && isWord(tokens[k + 1], "ALTER")) k += 2;
    const kind = isWord(tokens[k], "FUNCTION") ? "FUNCTION"
      : isWord(tokens[k], "PROC") || isWord(tokens[k], "PROCEDURE") ? "PROCEDURE" : null;
    if (!kind) return null;
    const first = identifier(tokens[++k]);
    if (!first) throw new Error("Falta el nombre de un SP o función.");
    let schema = "dbo";
    let name = first;
    if (tokens[k + 1] && tokens[k + 1].value === ".") {
      schema = first;
      name = identifier(tokens[k + 2]);
      k += 2;
      if (!name || (tokens[k + 1] && tokens[k + 1].value === ".")) {
        throw new Error("Usa nombres con el formato esquema.objeto.");
      }
    }
    return { schema, name, kind, start: tokens[i].start, nameEnd: tokens[k].end, nameIndex: k };
  }

  function scanSource(source) {
    let sql = source.content || "";
    sql = sql.replace(/\r\n?/g, "\n");
    const tokens = tokenize(sql);
    const modules = [];
    const issues = [];
    const separators = [];
    for (let i = 0; i < tokens.length; i++) {
      let item;
      try { item = declaration(tokens, i); }
      catch (error) { issues.push({ source: source.name, message: error.message }); continue; }
      if (item) {
        modules.push(item);
        i = item.nameIndex;
        continue;
      }
      if (isWord(tokens[i], "GO")) {
        const lineStart = sql.lastIndexOf("\n", tokens[i].start - 1) + 1;
        const lineEnd = sql.indexOf("\n", tokens[i].end);
        const line = sql.slice(lineStart, lineEnd < 0 ? sql.length : lineEnd);
        if (/^\s*GO(?:\s+\d+)?\s*(?:--.*)?$/i.test(line)) separators.push(lineStart);
      }
    }
    if (!modules.length && sql.trim()) issues.push({ source: source.name, message: "No se encontraron definiciones CREATE/ALTER PROCEDURE o FUNCTION." });
    const items = modules.map((item, index) => {
      const next = modules[index + 1];
      let end = next ? next.start : sql.length;
      const separator = separators.find((position) => position > item.start && position < end);
      if (separator !== undefined) end = separator;
      const definition = sql.slice(item.start, end).trim();
      const parts = splitDefinition(definition);
      const lexicalError = tokens.lexicalError;
      let error = lexicalError && lexicalError.start >= item.start && lexicalError.start < end ? lexicalError.message : "";
      if (!error && (parts.body === null || !parts.body.trim())) error = "Falta AS y el cuerpo de " + item.schema + "." + item.name + ".";
      if (!error) {
        let depth = 0;
        for (const token of tokenize(definition)) {
          if (token.value === "(") depth++;
          if (token.value === ")") depth--;
          if (depth < 0) break;
        }
        if (depth !== 0) error = "Paréntesis sin completar en la definición.";
      }
      if (!error) {
        const bodyTokens = tokenize(parts.body);
        const blocks = [];
        for (let i = 0; i < bodyTokens.length; i++) {
          const token = bodyTokens[i];
          if (isWord(token, "CASE")) blocks.push("CASE");
          if (isWord(token, "BEGIN") && !["TRAN", "TRANSACTION", "DISTRIBUTED", "DIALOG", "CONVERSATION"].some((word) => isWord(bodyTokens[i + 1], word))) blocks.push("BEGIN");
          if (isWord(token, "END") && !isWord(bodyTokens[i + 1], "CONVERSATION")) {
            if (!blocks.length) { error = "END sin un bloque BEGIN o CASE correspondiente."; break; }
            blocks.pop();
          }
        }
        if (!error && blocks.length) error = "Falta END para completar el cuerpo del objeto.";
      }
      return {
        id: source.id + ":" + item.start, sourceId: source.id, source: source.name,
        line: sql.slice(0, item.start).split("\n").length,
        schema: item.schema, name: item.name, kind: item.kind, definition, error,
        status: error ? "invalid" : "pending",
      };
    });
    return { modules: items, issues };
  }

  function objectKey(item) {
    return JSON.stringify([item.schema.toLowerCase(), item.name.toLowerCase()]);
  }

  function analyzeSources(sources) {
    const modules = [];
    const issues = [];
    for (const source of sources) {
      if (source.error) { issues.push({ source: source.name, message: source.error }); continue; }
      const scanned = scanSource(source);
      modules.push(...scanned.modules);
      issues.push(...scanned.issues);
    }
    const groups = new Map();
    for (const item of modules) {
      const key = objectKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const item of group) {
        item.error = "El objeto " + item.schema + "." + item.name + " está repetido. Conserva una sola definición para compararlo.";
        item.status = "duplicate";
      }
    }
    return { modules, issues };
  }

  // API estricta conservada para consumidores que necesitan validar todo el lote.
  function parseModules(sql) {
    const analyzed = analyzeSources([{ id: "pasted", name: "Contenido pegado", content: sql }]);
    const problem = analyzed.issues.find((issue) => !issue.message.startsWith("No se encontraron"));
    if (problem) throw new Error(problem.message);
    if (!analyzed.modules.length) throw new Error("Pega al menos un CREATE/ALTER PROCEDURE o FUNCTION completo.");
    const invalid = analyzed.modules.find((item) => item.error);
    if (invalid) throw new Error(invalid.error);
    if (analyzed.issues.length) throw new Error(analyzed.issues[0].message);
    return analyzed.modules;
  }

  function canonicalDefinition(sql) {
    sql = sql.replace(/\r\n?/g, "\n").trim();
    const tokens = tokenize(sql);
    for (let i = 0; i < tokens.length; i++) {
      const item = declaration(tokens, i);
      if (item) {
        // CREATE / ALTER / CREATE OR ALTER y las comillas del nombre no cambian
        // el contenido; ambos lados ya se emparejaron por esquema y nombre.
        return "CREATE " + item.kind + " [objeto]" + sql.slice(item.nameEnd);
      }
    }
    return sql;
  }

  function splitDefinition(sql) {
    const tokens = tokenize(sql);
    const module = declaration(tokens, 0);
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.value === "(") depth++;
      if (token.value === ")") depth--;
      const previous = tokens[i - 1];
      if (depth === 0 && isWord(token, "AS") && !isWord(previous, "EXECUTE") &&
          !(previous && previous.type === "word" && previous.value.startsWith("@"))) {
        return { header: sql.slice(0, token.start).trim(), body: sql.slice(token.end).trim(), bodyStart: token.end };
      }
      // Las funciones inline pueden omitir AS antes de RETURN.
      if (depth === 0 && module && module.kind === "FUNCTION" && isWord(token, "RETURN")) {
        return { header: sql.slice(0, token.start).trim(), body: sql.slice(token.start).trim(), bodyStart: token.start };
      }
    }
    return { header: sql.trim(), body: null };
  }

  function normalizedTokens(tokens) {
    return tokens.map((t) => t.type === "string" ? t.value : identifier(t) !== null
      ? identifier(t).toUpperCase() : t.value).join(" ");
  }

  // Separa parámetros respetando las comas de DECIMAL, defaults y tablas de retorno.
  function signature(sql) {
    const tokens = tokenize(sql);
    const module = declaration(tokens, 0);
    if (!module) return { parameters: [], returns: "", options: "", kind: "" };
    const rest = tokenize(sql.slice(module.nameEnd));
    const parameters = [];
    let cursor = 0;
    let parameterTokens = [];
    if (module.kind === "FUNCTION" && rest[0] && rest[0].value === "(") {
      let depth = 1;
      cursor = 1;
      while (cursor < rest.length && depth) {
        const token = rest[cursor++];
        if (token.value === "(") depth++;
        if (token.value === ")") depth--;
        if (depth) parameterTokens.push(token);
      }
    } else {
      while (cursor < rest.length && !isWord(rest[cursor], "WITH") && !isWord(rest[cursor], "FOR")) {
        parameterTokens.push(rest[cursor++]);
      }
    }
    let depth = 0;
    let part = [];
    const append = () => {
      if (!part.length || !part[0].value.startsWith("@")) { part = []; return; }
      const normalized = part.filter((t, i) => !(i === 1 && isWord(t, "AS"))).map((t) => isWord(t, "OUT") ? { ...t, value: "OUTPUT" } : t);
      parameters.push({ name: part[0].value, value: normalizedTokens(normalized), text: sql.slice(module.nameEnd + part[0].start, module.nameEnd + part[part.length - 1].end) });
      part = [];
    };
    for (const token of parameterTokens) {
      if (token.value === "(") depth++;
      if (token.value === ")") depth--;
      if (token.value === "," && depth === 0) append();
      else part.push(token);
    }
    append();
    const remaining = rest.slice(cursor);
    const optionsIndex = remaining.findIndex((t) => isWord(t, "WITH"));
    return {
      kind: module.kind, parameters,
      returns: module.kind === "FUNCTION" ? normalizedTokens(optionsIndex < 0 ? remaining : remaining.slice(0, optionsIndex)) : "",
      options: normalizedTokens(module.kind === "FUNCTION" ? optionsIndex < 0 ? [] : remaining.slice(optionsIndex) : remaining),
    };
  }

  function compareDefinitions(source, target) {
    const a = canonicalDefinition(source);
    const b = canonicalDefinition(target);
    if (a === b) {
      const alignedRows = alignLines(target, source).map((row) => ({
        left: row.right && { ...row.right, type: "equal" },
        right: row.left && { ...row.left, type: "equal" },
      }));
      return { same: true, label: "Sin cambios", lines: plainLines(source), alignedRows, changes: [] };
    }
    const left = splitDefinition(a);
    const right = splitDefinition(b);
    const sourceSignature = signature(left.header);
    const targetSignature = signature(right.header);
    const parameterChanges = [];
    const names = new Set([...targetSignature.parameters, ...sourceSignature.parameters].map((p) => p.name.toUpperCase()));
    for (const name of names) {
      const sourceIndex = sourceSignature.parameters.findIndex((p) => p.name.toUpperCase() === name);
      const targetIndex = targetSignature.parameters.findIndex((p) => p.name.toUpperCase() === name);
      const from = targetSignature.parameters[targetIndex];
      const to = sourceSignature.parameters[sourceIndex];
      if (!from || !to || from.value !== to.value || sourceIndex !== targetIndex) {
        parameterChanges.push({ name: (from || to).name, source: to ? to.text : "—", target: from ? from.text : "—",
          change: !from ? "Agregado" : !to ? "Eliminado" : from.value !== to.value ? "Modificado" : "Orden modificado" });
      }
    }
    const returnsChanged = sourceSignature.returns !== targetSignature.returns;
    const optionsChanged = sourceSignature.options !== targetSignature.options;
    const typeChanged = sourceSignature.kind !== targetSignature.kind;
    const bodyChanged = left.body !== right.body;
    const labels = [];
    if (typeChanged) labels.push("Tipo de objeto modificado");
    if (parameterChanges.length) labels.push("Parámetros modificados");
    if (returnsChanged) labels.push("Retorno modificado");
    if (optionsChanged) labels.push("Opciones modificadas");
    if (bodyChanged) labels.push("Cuerpo modificado");
    // Entorno = base actual; origen = propuesta. Solo se intercambia la posición
    // visual al final: el origen permanece a la izquierda.
    const lines = diffLines(target, source);
    const alignedRows = alignLines(target, source, lines).map((row) => ({ left: row.right, right: row.left }));
    return { same: false, label: labels.join(" + ") || "Formato o comentarios modificados", parameterChanges, returnsChanged, optionsChanged, lines, alignedRows, changes: changeBlocks(alignedRows) };
  }

  function plainLines(text) {
    return text.replace(/\r\n?/g, "\n").trim().split("\n").map((text, i) => ({ type: "equal", text, number: i + 1 }));
  }

  // LCS con prefijo/sufijo comunes y memoria acotada para scripts extensos.
  // El fallback conserva todas las líneas, aunque el bloque de cambios sea mayor.
  function diffLines(source, target) {
    const a = source.replace(/\r\n?/g, "\n").trim().split("\n");
    const b = target.replace(/\r\n?/g, "\n").trim().split("\n");
    const key = (s) => s.replace(/^(\s*)(?:CREATE\s+(?:OR\s+ALTER\s+)?|ALTER\s+)(PROC(?:EDURE)?|FUNCTION)\b/i,
      (_, space, kind) => space + "CREATE " + (/^PROC/i.test(kind) ? "PROCEDURE" : "FUNCTION"));
    const ak = a.map(key);
    const bk = b.map(key);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && ak[prefix] === bk[prefix]) prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && ak[a.length - 1 - suffix] === bk[b.length - 1 - suffix]) suffix++;
    const result = [];
    const add = (type, text, number) => result.push({ type, text, number });
    for (let i = 0; i < prefix; i++) add("equal", b[i], i + 1);
    const n = a.length - prefix - suffix;
    const m = b.length - prefix - suffix;
    if ((n + 1) * (m + 1) > 2000000) {
      for (let i = 0; i < n; i++) add("removed", a[prefix + i], null);
      for (let j = 0; j < m; j++) add("added", b[prefix + j], prefix + j + 1);
    } else {
      const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          table[i][j] = ak[prefix + i] === bk[prefix + j] ? 1 + table[i + 1][j + 1]
            : Math.max(table[i + 1][j], table[i][j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && ak[prefix + i] === bk[prefix + j]) {
          add("equal", b[prefix + j], prefix + j + 1); i++; j++;
        } else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) {
          add("removed", a[prefix + i++], null);
        } else {
          add("added", b[prefix + j], prefix + j + 1); j++;
        }
      }
    }
    for (let j = b.length - suffix; j < b.length; j++) add("equal", b[j], j + 1);
    return result;
  }

  // Cada fila ocupa la misma posición en ambos paneles. Los huecos no son
  // líneas del SQL: mantienen alineado el siguiente bloque coincidente.
  function alignLines(source, target, lines = diffLines(source, target)) {
    const sourceLines = source.replace(/\r\n?/g, "\n").trim().split("\n");
    const rows = [];
    let sourceIndex = 0;
    let removed = [];
    let added = [];
    const flush = () => {
      for (let i = 0; i < Math.max(removed.length, added.length); i++) {
        rows.push({ left: removed[i] || null, right: added[i] || null });
      }
      removed = [];
      added = [];
    };
    for (const line of lines) {
      if (line.type === "equal") {
        flush();
        rows.push({
          left: { type: "equal", text: sourceLines[sourceIndex], number: ++sourceIndex },
          right: { type: "equal", text: line.text, number: line.number },
        });
      } else if (line.type === "removed") {
        removed.push({ type: "removed", text: sourceLines[sourceIndex], number: ++sourceIndex });
      } else {
        added.push({ type: "added", text: line.text, number: line.number });
      }
    }
    flush();
    return rows;
  }

  function changeBlocks(rows) {
    const blocks = [];
    let block = null;
    rows.forEach((row, index) => {
      const added = row.left && row.left.type === "added";
      const removed = row.right && row.right.type === "removed";
      if (!added && !removed) { block = null; return; }
      if (!block) {
        block = { start: index, end: index, type: added && removed ? "modified" : added ? "added" : "removed", sourceLine: null, targetLine: null };
        blocks.push(block);
      }
      block.end = index;
      if ((added && block.type === "removed") || (removed && block.type === "added")) block.type = "modified";
      if (row.left && block.sourceLine === null) block.sourceLine = row.left.number;
      if (row.right && block.targetLine === null) block.targetLine = row.right.number;
    });
    return blocks;
  }

  // SSMS exporta frecuentemente UTF-16; también se aceptan UTF-8 y Windows-1252.
  function decodeSql(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    let encoding = "utf-8";
    let start = 0;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; start = 2; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; start = 2; }
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
    else if (bytes.length > 4 && bytes[1] === 0 && bytes[3] === 0) encoding = "utf-16le";
    else if (bytes.length > 4 && bytes[0] === 0 && bytes[2] === 0) encoding = "utf-16be";
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start)); }
    catch (error) {
      if (encoding !== "utf-8") throw new Error("El archivo contiene una secuencia UTF-16 incompleta.");
      text = new TextDecoder("windows-1252").decode(bytes);
    }
    if (text.includes("\0")) throw new Error("El archivo no contiene texto SQL válido.");
    return text.replace(/^\uFEFF/, "");
  }

  const api = { analyzeSources, parseModules, compareDefinitions, diffLines, alignLines, decodeSql };
  root.SqlCompare = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
