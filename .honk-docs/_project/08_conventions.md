# Conventions

> Team workflow conventions for branches, commits, pull requests, releases, and
> review. Generated artifacts should follow these conventions.

> **Estado actual:** rama `main`. Convenciones de
> equipo no documentadas; campos marcados `[pendiente]`.

## Branching

**Model:** [pendiente — confirmar (trunk-based, git-flow, etc.)]

| Branch | Purpose | Rules |
|---|---|---|
| main | Rama principal. | [pendiente] |
| [pendiente] | [pendiente] | [pendiente] |

## Branch Naming

```text
[pendiente]
```

## Commit Style

**Format:** [pendiente — estilo observado: imperativo breve con prefijo]

```text
[pendiente]
```

**Examples:**

```text
Init: helptext helper
```

## Pull Requests

**Template:** [pendiente]

**Required sections:**

- [pendiente]

**Reviewers:**

- [pendiente]

**Merge strategy:** [pendiente]

## Releases

**Versioning:** SemVer sincronizado en `Cargo.toml`, `Cargo.lock` y `tauri.conf.json`; incremento automático de parche desde `main`.

```text
Push a main -> incremento de parche y etiqueta automáticos -> pruebas y firma -> GitHub Release pública
```

## Code Review

- [pendiente]

## Other Conventions

- Idioma del proyecto (UI, comentarios, mensajes de error): español.
- `.gitignore` excluye compilaciones, configuraciones locales, conexiones, claves
  privadas y exportaciones SQL. No se incorporan datos de conexiones reales.
