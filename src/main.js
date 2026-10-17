const invoke = window.__TAURI__.core.invoke;
const $ = (id) => document.getElementById(id);

// ---------- estado ----------
let store = { environments: [], activeEnv: 0, currentDb: "" };
let databases = null;      // cache de bases del entorno activo (null = sin cargar)
let dbQuery = "";          // texto del buscador del selector
let dbFiltered = [];       // bases visibles tras filtrar
let dbActive = 0;          // índice resaltado (navegación con flechas)
let fDbSelected = "";      // BD elegida en el formulario del modal
let fDbAll = [];           // bases cargadas en el picker del modal
let editingIndex = 0;      // entorno mostrado en el formulario del modal
let formAuth = "sql";      // "sql" | "windows"
let lastScript = "";       // script generado (solo objetos correctos)
let objects = [];          // lista gestionada de objetos a procesar
let comparison = null;    // reutiliza la conexión y base de datos activas
let persistenceQueue = Promise.resolve();

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function activeEnv() {
  return store.environments[store.activeEnv] || null;
}
function connFromEnv(env) {
  if (!env) return null;
  return {
    server: env.server || "",
    port: env.port ? Number(env.port) : null,
    auth: env.auth || "sql",
    user: env.user || "",
    password: env.password || "",
    database: env.database || "",
  };
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, type = "") {
  const t = $("toast");
  t.className = "toast" + (type ? " " + type : "");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- render barra superior ----------
function renderTopbar() {
  const env = activeEnv();
  $("envName").textContent = env ? env.name : "—";
  $("envServer").textContent = env ? env.server : "sin entorno";
  $("envDot").style.background = env ? env.dot : "#c2c8d2";
  $("currentDb").textContent = store.currentDb || "Seleccionar";
  if (comparison) comparison.refreshContext();
}

// ---------- modo de trabajo ----------
function setMode() {
  const compare = $("modeSelect").value === "compare";
  const selected = document.querySelector('.tool-option[data-mode="' + (compare ? "compare" : "extract") + '"]');
  $("toolLabel").textContent = selected.querySelector(".tool-option-title").textContent;
  $("toolIcon").replaceChildren(selected.querySelector("svg").cloneNode(true));
  $("toolButton").setAttribute("aria-label", "Herramienta: " + $("toolLabel").textContent);
  for (const option of document.querySelectorAll(".tool-option")) option.setAttribute("aria-selected", String(option === selected));
  closeToolMenu();
  $("extractView").hidden = compare;
  $("compareView").hidden = !compare;
  $("runBtn").hidden = compare;
  $("compareBtn").hidden = !compare;
  if (comparison) comparison.setVisible(compare);
}

let activeTool = 0;
function closeToolMenu() {
  $("toolMenu").hidden = true;
  $("toolButton").setAttribute("aria-expanded", "false");
  $("toolButton").removeAttribute("aria-activedescendant");
  for (const option of document.querySelectorAll(".tool-option")) option.classList.remove("keyboard-active");
}
function highlightTool(index) {
  const options = Array.from(document.querySelectorAll(".tool-option"));
  activeTool = (index + options.length) % options.length;
  options.forEach((option, i) => option.classList.toggle("keyboard-active", i === activeTool));
  $("toolButton").setAttribute("aria-activedescendant", options[activeTool].id);
}
function openToolMenu(keyboard = false) {
  $("envMenu").hidden = true;
  $("dbMenu").hidden = true;
  $("toolMenu").hidden = false;
  $("toolButton").setAttribute("aria-expanded", "true");
  activeTool = Array.from(document.querySelectorAll(".tool-option"))
    .findIndex((option) => option.dataset.mode === $("modeSelect").value);
  if (keyboard) highlightTool(activeTool);
}
function chooseTool(option) {
  $("modeSelect").value = option.dataset.mode;
  $("modeSelect").dispatchEvent(new Event("change", { bubbles: true }));
  $("toolButton").focus({ preventScroll: true });
}
function onToolKey(event) {
  const open = !$("toolMenu").hidden;
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    if (!open) openToolMenu(true);
    if (event.key === "Home") highlightTool(0);
    else if (event.key === "End") highlightTool(document.querySelectorAll(".tool-option").length - 1);
    else if (open) highlightTool(activeTool + (event.key === "ArrowDown" ? 1 : -1));
  } else if (open && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    chooseTool(document.querySelectorAll(".tool-option")[activeTool]);
  } else if (event.key === "Escape" && open) {
    event.preventDefault();
    event.stopPropagation();
    closeToolMenu();
  } else if (event.key === "Tab") closeToolMenu();
  else if (!event.ctrlKey && !event.altKey && !event.metaKey && /^[ec]$/i.test(event.key)) {
    event.preventDefault();
    if (!open) openToolMenu();
    const mode = event.key.toLowerCase() === "e" ? "extract" : "compare";
    highlightTool(Array.from(document.querySelectorAll(".tool-option"))
      .findIndex((option) => option.dataset.mode === mode));
  }
}

// ---------- selector de entorno (barra superior) ----------
function toggleEnvMenu() {
  const menu = $("envMenu");
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  renderEnvMenu();
  menu.hidden = false;
}
function renderEnvMenu() {
  const list = $("envMenuList");
  list.innerHTML = "";
  store.environments.forEach((env, i) => {
    const item = document.createElement("div");
    item.className = "env-menu-item" + (i === store.activeEnv ? " active" : "");
    item.innerHTML =
      '<span class="emi-dot" style="background:' + env.dot + '"></span>' +
      '<div class="emi-body">' +
      '<div class="emi-name">' + escapeHtml(env.name) + "</div>" +
      '<div class="emi-server">' + escapeHtml(env.server || "—") + "</div>" +
      "</div>" +
      (i === store.activeEnv ? '<span class="emi-check">✓</span>' : "");
    item.onclick = () => chooseEnv(i);
    list.appendChild(item);
  });
}
function chooseEnv(i) {
  store.activeEnv = i;
  const env = store.environments[i];
  store.currentDb = env && env.database ? env.database : "";
  databases = null; // el servidor cambió → refrescar bases
  $("envMenu").hidden = true;
  renderTopbar();
  persist();
}

// ---------- lista de objetos ----------
function addObjects(text) {
  const parts = String(text).split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
  let added = 0;
  for (const p of parts) {
    if (!objects.some((o) => o.toLowerCase() === p.toLowerCase())) {
      objects.push(p);
      added++;
    }
  }
  if (added) renderObjects();
  return added;
}
function removeObject(i) {
  objects.splice(i, 1);
  renderObjects();
}
function clearObjects() {
  objects = [];
  renderObjects();
}
function renderObjects() {
  renderObjList();
  renderQueue();
  $("objClear").hidden = objects.length === 0;
}
function renderQueue() {
  $("queueCount").textContent = objects.length + " en cola";
}
function renderObjList() {
  const list = $("objList");
  list.innerHTML = "";
  if (objects.length === 0) {
    list.innerHTML =
      '<div class="obj-empty">Sin objetos todavía.<br>Escribe o pega arriba y pulsa Enter.</div>';
    return;
  }
  objects.forEach((name, i) => {
    const row = document.createElement("div");
    row.className = "obj-row";
    row.title = name; // tooltip con el valor completo

    const nm = document.createElement("span");
    nm.className = "obj-name";
    nm.textContent = name;

    const del = document.createElement("button");
    del.className = "obj-del";
    del.title = "Eliminar";
    del.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>';
    del.onclick = () => removeObject(i);

    row.appendChild(nm);
    row.appendChild(del);
    list.appendChild(row);
  });
}

// ---------- selector de base de datos ----------
async function toggleDbMenu() {
  const menu = $("dbMenu");
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  menu.hidden = false;
  $("dbSearch").value = "";
  dbQuery = "";
  dbActive = 0;

  if (databases === null) {
    $("dbList").innerHTML = '<div class="db-empty">Cargando…</div>';
    $("dbCount").textContent = "";
    const env = activeEnv();
    if (!env) {
      $("dbList").innerHTML = '<div class="db-empty">Configura un entorno primero</div>';
      return;
    }
    try {
      databases = await invoke("list_databases", { conn: connFromEnv(env) });
    } catch (e) {
      databases = null;
      $("dbList").innerHTML = '<div class="db-empty">No se pudo listar</div>';
      toast(String(e), "err");
      return;
    }
  }
  renderDbList("");
  $("dbSearch").focus();
}

// resalta el fragmento coincidente al estilo select2
function dbHighlight(name, q) {
  if (!q) return escapeHtml(name);
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return escapeHtml(name);
  return (
    escapeHtml(name.slice(0, i)) +
    "<mark>" + escapeHtml(name.slice(i, i + q.length)) + "</mark>" +
    escapeHtml(name.slice(i + q.length))
  );
}

function renderDbList(query) {
  if (query !== undefined) {
    dbQuery = query;
    dbActive = 0;
  }
  const list = $("dbList");
  if (!databases) {
    list.innerHTML = '<div class="db-empty">Cargando…</div>';
    $("dbCount").textContent = "";
    return;
  }
  const q = dbQuery.trim().toLowerCase();
  dbFiltered = q ? databases.filter((n) => n.toLowerCase().includes(q)) : databases.slice();
  $("dbCount").textContent = dbFiltered.length + "/" + databases.length;

  if (dbActive >= dbFiltered.length) dbActive = dbFiltered.length - 1;
  if (dbActive < 0) dbActive = 0;

  if (dbFiltered.length === 0) {
    list.innerHTML = '<div class="db-empty">Sin coincidencias</div>';
    return;
  }

  list.innerHTML = "";
  const term = dbQuery.trim();
  dbFiltered.forEach((name, i) => {
    const row = document.createElement("div");
    row.className = "db-item" + (i === dbActive ? " active" : "");
    row.innerHTML =
      '<span class="db-item-name">' + dbHighlight(name, term) + "</span>" +
      (name === store.currentDb ? '<span class="check">✓</span>' : "");
    row.onclick = () => chooseDb(name);
    row.onmouseenter = () => {
      dbActive = i;
      markDbActive();
    };
    list.appendChild(row);
  });
}

function markDbActive() {
  const rows = $("dbList").children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("active", i === dbActive);
  }
}

function moveDbActive(delta) {
  if (!dbFiltered.length) return;
  dbActive = (dbActive + delta + dbFiltered.length) % dbFiltered.length;
  markDbActive();
  const el = $("dbList").children[dbActive];
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}

function onDbSearchKey(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveDbActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveDbActive(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (dbFiltered[dbActive]) chooseDb(dbFiltered[dbActive]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    $("dbMenu").hidden = true;
  }
}

function chooseDb(name) {
  store.currentDb = name;
  $("dbMenu").hidden = true;
  renderTopbar();
  persist();
}

// ---------- modal de conexión ----------
function openModal() {
  closeToolMenu();
  $("dbMenu").hidden = true;
  $("envMenu").hidden = true;
  editingIndex = store.activeEnv;
  renderEnvList();
  loadEnvIntoForm(editingIndex);
  setConnStatus("idle");
  $("modal").hidden = false;
}
function closeModal() {
  $("modal").hidden = true;
  if (comparison) comparison.resume();
}
function renderEnvList() {
  const list = $("envList");
  list.innerHTML = "";
  store.environments.forEach((env, i) => {
    const item = document.createElement("div");
    item.className = "env-item" + (i === editingIndex ? " active" : "");
    item.innerHTML =
      '<span class="env-item-dot" style="background:' + env.dot + '"></span>' +
      '<div class="env-item-body">' +
      '<div class="env-item-name">' + escapeHtml(env.name) + "</div>" +
      '<div class="env-item-server">' + escapeHtml(env.server || "—") + "</div>" +
      "</div>";
    item.onclick = () => {
      commitFormToState();
      editingIndex = i;
      loadEnvIntoForm(i);
      setConnStatus("idle");
      renderEnvList();
    };
    list.appendChild(item);
  });
}
function loadEnvIntoForm(i) {
  const env = store.environments[i];
  if (!env) return;
  $("fName").value = env.name || "";
  $("fServer").value = env.server || "";
  $("fPort").value = env.port != null ? env.port : "";
  $("fUser").value = env.user || "";
  $("fPass").value = env.password || "";
  setFdbValue(env.database || "");
  $("fDbMenu").hidden = true;
  setAuth(env.auth || "sql");
}
function setAuth(auth) {
  formAuth = auth === "windows" ? "windows" : "sql";
  $("authSql").classList.toggle("active", formAuth === "sql");
  $("authWin").classList.toggle("active", formAuth === "windows");
  $("credGrid").style.opacity = formAuth === "windows" ? "0.45" : "1";
  $("credGrid").style.pointerEvents = formAuth === "windows" ? "none" : "auto";
}

// ---------- picker de BD del modal (select opcional con carga) ----------
function setFdbValue(v) {
  fDbSelected = v || "";
  const el = $("fDbValue");
  if (fDbSelected) {
    el.textContent = fDbSelected;
    el.classList.remove("placeholder");
  } else {
    el.textContent = "Seleccionar…";
    el.classList.add("placeholder");
  }
}
async function toggleFdbMenu() {
  const menu = $("fDbMenu");
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  menu.hidden = false;
  $("fDbSearch").value = "";
  await loadFdb();
}
async function loadFdb() {
  const list = $("fDbList");
  const env = readForm();
  if (!env.server) {
    list.innerHTML = '<div class="db-empty">Indica el servidor primero</div>';
    return;
  }
  $("fDbSpinner").hidden = false;
  list.innerHTML = '<div class="fdb-loading"><span class="spinner"></span>Probando conexión…</div>';
  try {
    const dbs = await invoke("list_databases", { conn: connFromEnv(env) });
    fDbAll = dbs || [];
    $("fDbSpinner").hidden = true;
    renderFdbList("");
    setTimeout(() => $("fDbSearch").focus(), 0);
  } catch (e) {
    $("fDbSpinner").hidden = true;
    list.innerHTML =
      '<div class="db-empty">No se pudo conectar.<br>' + escapeHtml(String(e)) + "</div>";
  }
}
function renderFdbList(query) {
  const list = $("fDbList");
  const term = (query || "").trim().toLowerCase();
  const filtered = term ? fDbAll.filter((n) => n.toLowerCase().includes(term)) : fDbAll.slice();
  if (!filtered.length) {
    list.innerHTML = '<div class="db-empty">Sin coincidencias</div>';
    return;
  }
  list.innerHTML = "";
  filtered.forEach((name) => {
    const row = document.createElement("div");
    row.className = "db-item" + (name === fDbSelected ? " active" : "");
    row.innerHTML =
      '<span class="db-item-name">' + dbHighlight(name, (query || "").trim()) + "</span>" +
      (name === fDbSelected ? '<span class="check">✓</span>' : "");
    row.onclick = () => {
      setFdbValue(name);
      $("fDbMenu").hidden = true;
    };
    list.appendChild(row);
  });
}
function readForm() {
  const portRaw = $("fPort").value.trim();
  return {
    id: store.environments[editingIndex] ? store.environments[editingIndex].id : "env" + Date.now(),
    name: $("fName").value.trim() || "Sin nombre",
    server: $("fServer").value.trim(),
    port: portRaw ? Number(portRaw) : null,
    auth: formAuth,
    user: $("fUser").value,
    password: $("fPass").value,
    database: fDbSelected.trim(),
    dot: store.environments[editingIndex] ? store.environments[editingIndex].dot : "#2563eb",
  };
}
// vuelca el formulario al estado en memoria (sin persistir en disco)
function commitFormToState() {
  if (store.environments[editingIndex]) {
    store.environments[editingIndex] = readForm();
  }
}
function setConnStatus(kind, text, meta) {
  const el = $("connStatus");
  el.className = "conn-status " + kind;
  const labels = { idle: "Sin probar", busy: "Probando…", ok: "Conexión correcta", err: "Sin conexión" };
  $("connStatusText").textContent = text || labels[kind] || "";
  $("connStatusMeta").textContent = meta || "";
}

async function testConnection() {
  commitFormToState();
  const env = readForm();
  if (!env.server) {
    toast("Indica el servidor", "err");
    return;
  }
  setConnStatus("busy");
  try {
    const res = await invoke("test_connection", { conn: connFromEnv(env) });
    setConnStatus("ok", "Conexión correcta", "· " + res.version + " · " + res.latencyMs + " ms");
  } catch (e) {
    setConnStatus("err", "Sin conexión", "· " + String(e));
  }
}

async function saveEnv() {
  const env = readForm();
  if (!env.server) {
    toast("Indica el servidor", "err");
    return;
  }
  store.environments[editingIndex] = env;
  store.activeEnv = editingIndex;
  databases = null; // el entorno cambió; refrescar bases
  if (!await persist()) return;
  renderTopbar();
  closeModal();
  toast("Entorno guardado", "ok");
}

function newEnv() {
  commitFormToState();
  const env = {
    id: "env" + Date.now(),
    name: "Nuevo entorno",
    server: "",
    port: 1433,
    auth: "sql",
    user: "",
    password: "",
    database: "",
    dot: "#2563eb",
  };
  store.environments.push(env);
  editingIndex = store.environments.length - 1;
  renderEnvList();
  loadEnvIntoForm(editingIndex);
  setConnStatus("idle");
  $("fName").focus();
}

function deleteEnv() {
  if (store.environments.length <= 1) {
    toast("Debe quedar al menos un entorno", "err");
    return;
  }
  store.environments.splice(editingIndex, 1);
  editingIndex = 0;
  store.activeEnv = 0;
  databases = null;
  persist();
  renderEnvList();
  loadEnvIntoForm(0);
  renderTopbar();
  setConnStatus("idle");
}

function persist() {
  // Captura cada cambio antes de encolarlo: las escrituras no se adelantan ni
  // reciben por referencia una configuración modificada después por la UI.
  const snapshot = JSON.parse(JSON.stringify(store));
  persistenceQueue = persistenceQueue.then(async () => {
    try {
      await invoke("save_environments", { store: snapshot });
      return true;
    } catch (e) {
      toast("No se pudo guardar: " + e, "err");
      return false;
    }
  });
  return persistenceQueue;
}

// ---------- ejecutar ----------
async function run() {
  if ($("runBtn").disabled) return;
  if (objects.length === 0) {
    toast("Agrega al menos un objeto", "err");
    return;
  }
  const env = activeEnv();
  if (!env) {
    toast("Configura un entorno de conexión", "err");
    openModal();
    return;
  }
  const database = store.currentDb || env.database;
  if (!database) {
    toast("Elige una base de datos", "err");
    return;
  }

  const btn = $("runBtn");
  btn.disabled = true;
  btn.classList.add("busy");
  $("resultMeta").textContent = "ejecutando…";
  try {
    const gen = await invoke("generate_scripts", {
      conn: connFromEnv(env),
      database,
      objects,
    });
    renderResult(gen);
  } catch (e) {
    $("resultMeta").textContent = "error";
    toast(String(e), "err");
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
  }
}

function renderResult(gen) {
  lastScript = gen.script || "";
  const bar = "═".repeat(51);
  const parts = [];
  if (gen.header) parts.push(window.highlightSql(gen.header));
  gen.objects.forEach((o, i) => {
    if (o.error) {
      const head =
        "/* " + bar + "\n   Objeto " + (i + 1) + " de " + gen.totalObjects +
        "  ·  " + o.qualified + "  (no generado)\n   " + bar + " */";
      const body = "-- ⚠ " + o.error;
      parts.push('<span class="tok-err">' + escapeHtml(head + "\n" + body) + "</span>");
    } else {
      parts.push(window.highlightSql(o.script));
    }
  });

  $("codeView").innerHTML = parts.join("\n\n");
  $("codeView").hidden = false;
  $("emptyState").hidden = true;

  const failed = gen.totalObjects - gen.okObjects;
  let meta = gen.okObjects + "/" + gen.totalObjects + " objetos · " + gen.totalLines + " líneas";
  if (failed > 0) meta += " · " + failed + " con error";
  $("resultMeta").textContent = meta;

  const hasScript = lastScript.length > 0;
  $("copyBtn").classList.toggle("disabled", !hasScript);
  $("downloadBtn").classList.toggle("disabled", !hasScript);

  if (gen.okObjects > 0) toast("Script generado", "ok");
  else toast("Ningún objeto pudo resolverse", "err");
}

async function copyAll() {
  if (!lastScript) return;
  try {
    await navigator.clipboard.writeText(lastScript);
    toast("Copiado al portapapeles", "ok");
  } catch (e) {
    toast("No se pudo copiar", "err");
  }
}

async function downloadSql() {
  if (!lastScript) return;
  const db = store.currentDb || (activeEnv() && activeEnv().database) || "script";
  const name = db.replace(/[^\w.-]/g, "_") + "_helptext.sql";
  try {
    const path = await invoke("save_script", { content: lastScript, filename: name });
    if (path) toast("Guardado: " + path, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
}

// ---------- eventos ----------
function wire() {
  $("connBtn").onclick = openModal;
  $("envPill").onclick = toggleEnvMenu;
  $("envMenuManage").onclick = openModal;
  $("runBtn").onclick = run;
  $("modeSelect").addEventListener("change", setMode);
  $("toolButton").onclick = () => $("toolMenu").hidden ? openToolMenu() : closeToolMenu();
  $("toolButton").addEventListener("keydown", onToolKey);
  $("toolButton").addEventListener("blur", closeToolMenu);
  for (const option of document.querySelectorAll(".tool-option")) {
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.onclick = () => chooseTool(option);
  }
  $("dbBtn").onclick = toggleDbMenu;
  $("dbSearch").addEventListener("input", (e) => renderDbList(e.target.value));
  $("dbSearch").addEventListener("keydown", onDbSearchKey);

  $("modalClose").onclick = closeModal;
  $("cancelBtn").onclick = closeModal;
  $("modal").onclick = (e) => { if (e.target === $("modal")) closeModal(); };
  $("saveBtn").onclick = saveEnv;
  $("testBtn").onclick = testConnection;
  $("newEnvBtn").onclick = newEnv;
  $("deleteEnvBtn").onclick = deleteEnv;
  $("authSql").onclick = () => setAuth("sql");
  $("authWin").onclick = () => setAuth("windows");
  $("fDbBtn").onclick = toggleFdbMenu;
  $("fDbSearch").addEventListener("input", (e) => renderFdbList(e.target.value));

  $("copyBtn").onclick = copyAll;
  $("downloadBtn").onclick = downloadSql;

  $("objAdd").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = e.target.value;
      const added = addObjects(val);
      if (added === 0 && val.trim()) toast("Ese objeto ya está en la lista", "");
      e.target.value = "";
    }
  });
  $("objAdd").addEventListener("paste", (e) => {
    const t = (e.clipboardData || window.clipboardData).getData("text");
    if (t && /[\r\n,;]/.test(t)) {
      e.preventDefault();
      addObjects(t);
      e.target.value = "";
    }
  });
  $("objClear").onclick = clearObjects;

  // cerrar menús desplegables al hacer clic fuera
  document.addEventListener("click", (e) => {
    if (!$("toolPicker").contains(e.target)) closeToolMenu();
    [
      ["dbMenu", "dbBtn"],
      ["envMenu", "envPill"],
      ["fDbMenu", "fDbBtn"],
    ].forEach(([m, b]) => {
      const menu = $(m);
      if (menu && !menu.hidden && !menu.contains(e.target) && !e.target.closest("#" + b)) {
        menu.hidden = true;
      }
    });
  });

  // atajos de teclado
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      if (!$("modal").hidden) return;
      if ($("modeSelect").value === "compare") comparison.process();
      else run();
    }
    if (e.key === "Escape") {
      if (!$("fDbMenu").hidden) $("fDbMenu").hidden = true;
      else if (!$("modal").hidden) closeModal();
      else {
        $("dbMenu").hidden = true;
        $("envMenu").hidden = true;
      }
    }
  });
}

// ---------- init ----------
async function init() {
  comparison = window.createCompareWorkspace({
    invoke, toast, openConnections: openModal,
    getContext: () => {
      const env = activeEnv();
      return {
        conn: connFromEnv(env),
        database: store.currentDb || (env && env.database) || "",
        name: env ? env.name : "",
        modalOpen: !$("modal").hidden,
      };
    },
  });
  wire();
  setMode();
  try {
    const loaded = await invoke("load_environments");
    if (loaded && Array.isArray(loaded.environments)) {
      store = loaded;
      if (typeof store.activeEnv !== "number" || store.activeEnv >= store.environments.length) {
        store.activeEnv = 0;
      }
    }
  } catch (e) {
    toast("No se pudieron cargar los entornos: " + String(e), "err");
  }
  renderTopbar();
  renderObjects();
  $("copyBtn").classList.add("disabled");
  $("downloadBtn").classList.add("disabled");
  const updateNotifier = window.createUpdateNotifier({
    invoke, Channel: window.__TAURI__.core.Channel, toast,
    beforeRestart: async () => {
      const busy = () => !$("modal").hidden || $("runBtn").disabled || $("compareBtn").disabled || $("importSqlBtn").disabled;
      if (busy()) {
        toast("Termina la operación actual y cierra Conexiones antes de reiniciar.");
        return false;
      }
      const pendingSave = persistenceQueue;
      if (await pendingSave === false) {
        toast("Guarda las conexiones pendientes antes de reiniciar.", "err");
        return false;
      }
      if (busy() || pendingSave !== persistenceQueue) {
        toast("Espera a que terminen las operaciones pendientes antes de reiniciar.");
        return false;
      }
      return true;
    },
  });
  updateNotifier.start();
  window.addEventListener("beforeunload", updateNotifier.stop, { once: true });
}

init();
