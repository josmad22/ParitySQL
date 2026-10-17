const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const controller = fs.readFileSync(require.resolve("../src/updates.js"), "utf8");
const tick = () => new Promise(setImmediate);
const pending = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function setup(handler, beforeRestart) {
  const elements = new Map();
  const calls = [];
  const channels = [];
  const notices = [];
  let interval;
  let recovery;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, disabled: false, dataset: {}, attributes: {}, handlers: new Map(),
      textContent: "", title: "", classes: new Set(),
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key] ?? null; },
      removeAttribute(key) { delete this.attributes[key]; },
      addEventListener(name, fn) { this.handlers.set(name, fn); },
      removeEventListener(name) { this.handlers.delete(name); },
      classList: { toggle() {} }, style: { setProperty() {} },
    });
    return elements.get(id);
  };
  const window = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(controller, {
    window, document: { getElementById: element }, Date,
    setInterval: (fn) => { interval = fn; return 1; }, clearInterval() {},
    setTimeout: (fn) => { recovery = fn; return 2; }, clearTimeout() {},
  });
  class Channel { constructor() { channels.push(this); } }
  const notifier = window.createUpdateNotifier({
    invoke: async (name, args) => { calls.push(name); return handler(name, args); },
    Channel, toast: (...args) => notices.push(args), beforeRestart,
  });
  return {
    notifier, calls, channels, notices, element,
    button: element("updateButton"), label: element("updateLabel"),
    activate: () => element("updateButton").handlers.get("click")(),
    repeatCheck: () => interval(),
    recover: () => recovery(),
  };
}

test("oculta el aviso sin versión, sin configuración o sin conexión", async () => {
  for (const phase of ["idle", "disabled", "offline"]) {
    const ui = setup(() => phase === "offline" ? Promise.reject(new Error("sin red")) : { phase });
    ui.notifier.start(); await tick();
    assert.equal(ui.button.hidden, true);
    assert.equal(ui.notices.length, 0);
    if (phase === "disabled") { await ui.repeatCheck(); assert.equal(ui.calls.length, 1); }
    ui.notifier.stop();
  }
});

test("solo ofrece reiniciar cuando la descarga y verificación terminan", async () => {
  const download = pending();
  const ui = setup((name) => name === "check_for_updates"
    ? { phase: "available", version: "0.2.0" } : download.promise);
  ui.notifier.start(); await tick();
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.label.textContent, "Nueva versión disponible");
  const action = ui.activate();
  assert.equal(ui.button.disabled, true);
  ui.channels[0].onmessage({ downloaded: 50, total: 100 });
  assert.match(ui.label.textContent, /50%/);
  ui.channels[0].onmessage({ downloaded: 100, total: 100 });
  assert.equal(ui.label.textContent, "Verificando descarga…");
  assert.ok(!ui.calls.includes("install_update"));
  download.resolve({ phase: "ready", version: "0.2.0" }); await action;
  assert.equal(ui.label.textContent, "Reiniciar ahora");
  assert.equal(ui.button.disabled, false);
  assert.ok(!ui.calls.includes("install_update"));
  await ui.repeatCheck();
  assert.equal(ui.calls.filter(name => name === "check_for_updates").length, 1);
  ui.notifier.stop();
});

test("no duplica descargas y permite reintentar fallos de red o firma", async () => {
  const download = pending();
  const ui = setup((name) => name === "check_for_updates"
    ? { phase: "available", version: "0.2.0" } : download.promise);
  ui.notifier.start(); await tick();
  const first = ui.activate(); await ui.activate();
  assert.equal(ui.calls.filter(name => name === "download_update").length, 1);
  download.reject(new Error("firma inválida")); await first;
  assert.equal(ui.button.dataset.phase, "available");
  assert.match(ui.notices[0][0], /firma inválida/);
  assert.ok(!ui.calls.includes("install_update"));
  ui.notifier.stop();
});

test("instala únicamente al pulsar Reiniciar ahora y puede reintentar si falla", async () => {
  const ui = setup((name) => {
    if (name === "check_for_updates") return { phase: "available", version: "0.2.0" };
    if (name === "download_update") return { phase: "ready", version: "0.2.0" };
    throw new Error("instalador bloqueado");
  });
  ui.notifier.start(); await tick();
  await ui.activate(); await ui.activate();
  assert.equal(ui.calls.filter(name => name === "install_update").length, 1);
  assert.equal(ui.label.textContent, "Reiniciar ahora");
  assert.equal(ui.button.disabled, false);
  assert.match(ui.notices[0][0], /instalador bloqueado/);
  ui.notifier.stop();
});

test("respeta operaciones pendientes antes del reinicio", async () => {
  const ui = setup(() => ({ phase: "ready", version: "0.2.0" }), async () => false);
  ui.notifier.start(); await tick(); await ui.activate();
  assert.deepEqual(ui.calls, ["check_for_updates"]);
  assert.equal(ui.button.dataset.phase, "ready");
  ui.notifier.stop();
});

test("una comprobación sin novedades retira el aviso y no interfiere con clics simultáneos", async () => {
  const second = pending();
  let checks = 0;
  const ui = setup(() => ++checks === 1 ? { phase: "available", version: "0.2.0" } : second.promise);
  ui.notifier.start(); await tick();
  const check = ui.notifier.check();
  assert.equal(ui.button.disabled, true);
  await ui.activate();
  assert.ok(!ui.calls.includes("download_update"));
  second.resolve({ phase: "idle" }); await check;
  assert.equal(ui.button.hidden, true);
  ui.notifier.stop();
});

test("al detener el controlador no procesa respuestas tardías", async () => {
  const check = pending();
  const ui = setup(() => check.promise);
  ui.notifier.start(); ui.notifier.stop();
  check.resolve({ phase: "available", version: "0.2.0" }); await tick();
  assert.equal(ui.button.hidden, true);
});

test("recupera una descarga que seguía en Rust después de recargar la interfaz", async () => {
  let checks = 0;
  const ui = setup(() => ({ phase: ++checks === 1 ? "downloading" : "ready", version: "0.2.0" }));
  ui.notifier.start(); await tick();
  assert.equal(ui.button.disabled, true);
  await ui.recover();
  assert.equal(ui.label.textContent, "Reiniciar ahora");
  assert.equal(ui.button.disabled, false);
  assert.ok(!ui.calls.includes("download_update"));
  ui.notifier.stop();
});
