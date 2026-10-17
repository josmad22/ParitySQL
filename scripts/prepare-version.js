"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const versionFiles = ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"];
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";

function parseVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("La versión debe ser SemVer estable: X.Y.Z.");
  }
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("La versión excede el rango admitido.");
  return parts;
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function nextVersion(current, tags) {
  const parts = parseVersion(current);
  const stable = tags.filter(tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)).map(tag => tag.slice(1));
  const latest = stable.reduce((max, version) => !max || compareVersions(version, max) > 0 ? version : max, null);
  const series = parts.slice(0, 2).join(".");
  const latestParts = latest && parseVersion(latest);
  if (latestParts && (parts[0] < latestParts[0] || (parts[0] === latestParts[0] && parts[1] < latestParts[1]))) {
    throw new Error("La serie seleccionada es anterior a la última versión; elige una serie igual o superior manualmente.");
  }
  // Solo el responsable elige X.Y; Actions incrementa Z dentro de esa serie.
  const sameSeries = latestParts && latestParts.slice(0, 2).join(".") === series;
  if (!sameSeries) {
    if (parts[2] > 1) throw new Error("Una nueva serie debe comenzar en 1; configura " + series + ".0 o " + series + ".1.");
    parts[2] = 1;
  } else {
    parts[2] = Math.max(parts[2], latestParts[2] + 1);
  }
  const next = parts.join(".");
  parseVersion(next);
  return next;
}

function versionField(text, label) {
  const matches = [...text.matchAll(/^version[ \t]*=[ \t]*"([^"]+)"[^\r\n]*$/gm)];
  if (matches.length !== 1) throw new Error("No hay una única versión en " + label + ".");
  return matches[0][1];
}

function cargoPackage(text) {
  const header = /^\[package\][ \t]*\r?\n/m.exec(text);
  if (!header) throw new Error("Cargo.toml no contiene [package].");
  const start = header.index + header[0].length;
  const next = /^\[/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}

function lockPackage(text) {
  const headers = [...text.matchAll(/^\[\[package\]\][ \t]*\r?\n/gm)];
  const packages = headers.map((header, index) => ({ start: header.index, end: headers[index + 1]?.index ?? text.length }));
  const matches = packages.filter(section => /^name[ \t]*=[ \t]*"paritysql"[ \t]*$/m.test(text.slice(section.start, section.end)));
  if (matches.length !== 1) throw new Error("Cargo.lock debe contener un único paquete paritysql.");
  return matches[0];
}

function readVersions(read) {
  const [cargo, lock, json] = versionFiles.map(read);
  const section = cargoPackage(cargo);
  const packageText = cargo.slice(section.start, section.end);
  if (!/^name[ \t]*=[ \t]*"paritysql"[ \t]*$/m.test(packageText)) throw new Error("El paquete raíz debe ser paritysql.");
  const lockSection = lockPackage(lock);
  const versions = [versionField(packageText, "Cargo.toml"), versionField(lock.slice(lockSection.start, lockSection.end), "Cargo.lock"), JSON.parse(json).version];
  versions.forEach(parseVersion);
  if (!versions.every(version => version === versions[0])) throw new Error("Cargo.toml, Cargo.lock y tauri.conf.json deben tener la misma versión.");
  return versions[0];
}

function updateVersions(root, version) {
  parseVersion(version);
  readVersions(file => fs.readFileSync(path.join(root, file), "utf8"));
  for (const [index, file] of versionFiles.entries()) {
    const filename = path.join(root, file);
    let text = fs.readFileSync(filename, "utf8");
    if (index < 2) {
      const section = index === 0 ? cargoPackage(text) : lockPackage(text);
      const updated = text.slice(section.start, section.end).replace(/^(version[ \t]*=[ \t]*")[^"]+("[^\r\n]*)$/m, (_, before, after) => before + version + after);
      text = text.slice(0, section.start) + updated + text.slice(section.end);
    } else {
      const config = JSON.parse(text);
      config.version = version;
      text = JSON.stringify(config, null, 2) + "\n";
    }
    fs.writeFileSync(filename, text);
  }
}

function prepareVersion(root, { ref, sha }) {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("El commit de origen no es válido.");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  if (git("rev-parse", "HEAD") !== sha) throw new Error("El checkout no coincide con el commit solicitado.");
  if (git("status", "--porcelain")) throw new Error("La preparación necesita un checkout limpio.");
  const readAt = commit => file => git("show", commit + ":" + file);
  const tagCommit = tag => {
    try { return git("rev-parse", "--verify", "refs/tags/" + tag + "^{commit}"); }
    catch { return null; }
  };
  if (ref.startsWith("refs/tags/")) {
    const tag = ref.slice("refs/tags/".length);
    parseVersion(tag.slice(1));
    if (!tag.startsWith("v") || tagCommit(tag) !== sha || readVersions(readAt(sha)) !== tag.slice(1)) {
      throw new Error("La etiqueta debe coincidir con el commit y los tres archivos de versión.");
    }
    return { publish: true, tag, sha };
  }
  if (ref !== "refs/heads/main") throw new Error("Solo se publican main y etiquetas de versión.");
  git("fetch", "origin", "main", "--tags");
  const latest = git("rev-parse", "refs/remotes/origin/main");
  if (latest !== sha) {
    const version = readVersions(readAt(latest));
    const tag = "v" + version;
    // Reintentar el mismo push reutiliza su commit de versión, incluso si falló la compilación.
    if (git("show", "-s", "--format=%P", latest) === sha
        && git("show", "-s", "--format=%s", latest) === "chore: release " + tag
        && git("show", "-s", "--format=%ae", latest) === botEmail
        && tagCommit(tag) === latest) return { publish: true, tag, sha: latest };
    return { publish: false, reason: "main tiene cambios posteriores; se publicará la ejecución más reciente." };
  }
  const current = readVersions(file => fs.readFileSync(path.join(root, file), "utf8"));
  const currentTag = "v" + current;
  if (tagCommit(currentTag) === sha) return { publish: true, tag: currentTag, sha };
  const tags = git("tag", "--list", "v*").split("\n");
  const version = nextVersion(current, tags);
  const tag = "v" + version;
  if (version !== current) {
    updateVersions(root, version);
    git("add", "--", ...versionFiles);
    git("-c", "user.name=github-actions[bot]", "-c", "user.email=" + botEmail, "commit", "-m", "chore: release " + tag);
  }
  git("tag", tag);
  const prepared = git("rev-parse", "HEAD");
  try {
    // Rama y etiqueta avanzan juntas; nunca se fuerza una subida ni se reemplaza una etiqueta.
    git("push", "--atomic", "origin", "HEAD:refs/heads/main", "refs/tags/" + tag);
  } catch {
    git("fetch", "origin", "main", "--tags");
    const remoteTag = git("ls-remote", "--tags", "origin", "refs/tags/" + tag).split(/\s+/)[0];
    if (remoteTag === prepared) return { publish: true, tag, sha: prepared };
    if (git("rev-parse", "refs/remotes/origin/main") !== sha) {
      return { publish: false, reason: "main avanzó durante la preparación; se publicará la ejecución más reciente." };
    }
    throw new Error("No se pudo subir la versión. Revisa contents: write y las reglas de protección de main.");
  }
  return { publish: true, tag, sha: prepared };
}

if (require.main === module) {
  try {
    if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Este script se ejecuta desde GitHub Actions.");
    const result = prepareVersion(path.resolve(__dirname, ".."), { ref: process.env.GITHUB_REF || "", sha: process.env.GITHUB_SHA || "" });
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "publish=" + result.publish + "\ntag=" + (result.tag || "") + "\nsha=" + (result.sha || "") + "\n");
    }
    console.log(result.reason || "Versión preparada: " + result.tag + " (" + result.sha + ")");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseVersion, compareVersions, nextVersion, readVersions, updateVersions, prepareVersion };
