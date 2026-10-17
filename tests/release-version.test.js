"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseVersion, nextVersion, readVersions, updateVersions, prepareVersion } = require("../scripts/prepare-version");

function project(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paritysql-version-test-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + "paritysql-version-test-"));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
  });
  const root = path.join(directory, "project");
  const remote = path.join(directory, "remote.git");
  fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  fs.writeFileSync(path.join(root, "src-tauri/Cargo.toml"), '[package]\nname = "paritysql"\nversion = "0.1.0"\n\n[dependencies]\nexample = { version = "0.1.0" }\n');
  fs.writeFileSync(path.join(root, "src-tauri/Cargo.lock"), 'version = 4\n\n[[package]]\nname = "other"\nversion = "0.1.0"\n\n[[package]]\nname = "paritysql"\nversion = "0.1.0"\ndependencies = ["other"]\n\n[[package]]\nname = "last"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.1.0", productName: "ParitySQL", plugins: { updater: { pubkey: "test-public-key" } } }, null, 2) + "\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--bare", remote);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Version tests");
  git("config", "user.email", "tests@example.com");
  const commit = message => { git("add", "--all"); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  commit("initial");
  git("remote", "add", "origin", remote);
  git("tag", "v0.1.0");
  git("push", "origin", "main", "v0.1.0");
  const read = file => fs.readFileSync(path.join(root, file), "utf8");
  const change = name => { fs.writeFileSync(path.join(root, name), name); const sha = commit(name); git("push", "origin", "main"); return sha; };
  return { root, remote, git, read, commit, change };
}

test("incrementa solo el parche de la serie seleccionada manualmente", () => {
  assert.equal(nextVersion("0.1.0", ["v0.1.0"]), "0.1.1");
  assert.equal(nextVersion("0.1.0", ["v0.1.9", "v0.1.10", "v1.0.0-rc.1", "other"]), "0.1.11");
  assert.equal(nextVersion("0.1.1", ["v0.1.1"]), "0.1.2");
  assert.equal(nextVersion("0.1.20", ["v0.1.10"]), "0.1.20");
  assert.throws(() => nextVersion("0.1.0", ["v2.0.3"]), /serie seleccionada es anterior/);
  assert.throws(() => nextVersion("1.9.0", ["v2.0.1"]), /serie seleccionada es anterior/);
  assert.throws(() => nextVersion("0.1.0", ["v0.1.9007199254740991"]), /rango admitido/);
  for (const invalid of ["0.01.0", "1.0.0-beta", "v1.0.0", "1.0", undefined, ["1.0.0"], "1.0.9007199254740992"]) {
    assert.throws(() => parseVersion(invalid));
  }
});

test("cada nueva serie comienza en uno y nunca hereda el parche de la anterior", () => {
  assert.equal(nextVersion("0.2.0", ["v0.1.25"]), "0.2.1");
  assert.equal(nextVersion("0.2.1", ["v0.1.25"]), "0.2.1");
  assert.equal(nextVersion("0.2.1", ["v0.1.25", "v0.2.1"]), "0.2.2");
  assert.equal(nextVersion("1.0.0", ["v0.9.99"]), "1.0.1");
  assert.equal(nextVersion("1.0.0", []), "1.0.1");
  assert.throws(() => nextVersion("0.2.5", ["v0.1.25"]), /nueva serie debe comenzar en 1/);
});

test("sincroniza solo el paquete raíz y conserva dependencias, clave pública y nombre", t => {
  const p = project(t);
  updateVersions(p.root, "0.1.1");
  assert.equal(readVersions(p.read), "0.1.1");
  assert.match(p.read("src-tauri/Cargo.toml"), /example = \{ version = "0.1.0" \}/);
  assert.match(p.read("src-tauri/Cargo.lock"), /name = "other"\nversion = "0.1.0"/);
  assert.match(p.read("src-tauri/Cargo.lock"), /name = "last"\nversion = "0.1.0"/);
  const config = JSON.parse(p.read("src-tauri/tauri.conf.json"));
  assert.equal(config.productName, "ParitySQL");
  assert.equal(config.plugins.updater.pubkey, "test-public-key");
});

test("rechaza versiones desalineadas antes de modificar archivos", t => {
  const p = project(t);
  const filename = path.join(p.root, "src-tauri/tauri.conf.json");
  fs.writeFileSync(filename, JSON.stringify({ version: "0.2.0" }));
  const before = p.read("src-tauri/Cargo.toml");
  assert.throws(() => updateVersions(p.root, "0.1.1"), /misma versión/);
  assert.equal(p.read("src-tauri/Cargo.toml"), before);
});

test("un push crea una sola versión y un reintento recupera el mismo commit y etiqueta", t => {
  const p = project(t);
  const source = p.change("feature.txt");
  p.git("checkout", "--detach", source);
  const release = prepareVersion(p.root, { ref: "refs/heads/main", sha: source });
  assert.equal(release.tag, "v0.1.1");
  assert.equal(release.publish, true);
  assert.equal(readVersions(p.read), "0.1.1");
  assert.equal(p.git("show", "-s", "--format=%P", release.sha), source);
  assert.equal(p.git("show", "-s", "--format=%ae", release.sha), "41898282+github-actions[bot]@users.noreply.github.com");
  assert.ok(p.git("ls-remote", "origin", "refs/heads/main").startsWith(release.sha));
  assert.ok(p.git("ls-remote", "origin", "refs/tags/v0.1.1").startsWith(release.sha));
  p.git("checkout", "--detach", source);
  assert.deepEqual(prepareVersion(p.root, { ref: "refs/heads/main", sha: source }), release);
  assert.equal(p.git("tag", "--list").split("\n").length, 2);
});

test("un cambio manual de serie desde cero publica uno y continúa con dos", t => {
  const p = project(t);
  updateVersions(p.root, "0.2.0");
  const source = p.commit("new minor");
  p.git("push", "origin", "main");
  const release = prepareVersion(p.root, { ref: "refs/heads/main", sha: source });
  assert.equal(release.tag, "v0.2.1");
  assert.equal(readVersions(p.read), "0.2.1");
  assert.equal(p.git("tag", "--list", "v0.2.0"), "");
  assert.equal(p.git("show", "-s", "--format=%P", release.sha), source);
  p.git("checkout", "--detach", source);
  assert.deepEqual(prepareVersion(p.root, { ref: "refs/heads/main", sha: source }), release);
  p.git("checkout", "main");
  const nextSource = p.change("next-feature.txt");
  const next = prepareVersion(p.root, { ref: "refs/heads/main", sha: nextSource });
  assert.equal(next.tag, "v0.2.2");
  assert.equal(readVersions(p.read), "0.2.2");
});

test("una nueva serie elegida directamente en uno no añade un commit vacío", t => {
  const p = project(t);
  updateVersions(p.root, "0.2.1");
  const source = p.commit("new minor at one");
  p.git("push", "origin", "main");
  const release = prepareVersion(p.root, { ref: "refs/heads/main", sha: source });
  assert.deepEqual(release, { publish: true, tag: "v0.2.1", sha: source });
  assert.deepEqual(prepareVersion(p.root, { ref: "refs/heads/main", sha: source }), release);
});

test("una subida posterior evita publicar un checkout antiguo o sobrescribir main", t => {
  const p = project(t);
  const old = p.change("first.txt");
  const latest = p.change("second.txt");
  p.git("checkout", "--detach", old);
  assert.equal(prepareVersion(p.root, { ref: "refs/heads/main", sha: old }).publish, false);
  assert.ok(p.git("ls-remote", "origin", "refs/heads/main").startsWith(latest));
  assert.equal(p.git("tag", "--list", "v0.1.1"), "");
  assert.equal(readVersions(p.read), "0.1.0");
});

test("las etiquetas manuales requieren una versión coincidente y no modifican el código", t => {
  const p = project(t);
  const sha = p.git("rev-parse", "HEAD");
  assert.deepEqual(prepareVersion(p.root, { ref: "refs/tags/v0.1.0", sha }), { publish: true, tag: "v0.1.0", sha });
  p.git("tag", "v0.2.0");
  assert.throws(() => prepareVersion(p.root, { ref: "refs/tags/v0.2.0", sha }), /debe coincidir/);
  assert.equal(p.git("status", "--porcelain"), "");
});

test("no publica checkouts sucios, ramas ajenas ni commits distintos del solicitado", t => {
  const p = project(t);
  const sha = p.git("rev-parse", "HEAD");
  assert.throws(() => prepareVersion(p.root, { ref: "refs/heads/develop", sha }), /Solo se publican/);
  assert.throws(() => prepareVersion(p.root, { ref: "refs/heads/main", sha: "a".repeat(40) }), /no coincide/);
  fs.writeFileSync(path.join(p.root, "untracked.txt"), "pending");
  assert.throws(() => prepareVersion(p.root, { ref: "refs/heads/main", sha }), /checkout limpio/);
});
