# AGENTS.md

This file provides guidance to AGENTS Code when working with code in this repository.

## Overview

Obsidian **desktop-only** plugin (`isDesktopOnly: true` in `manifest.json`, because it shells out via `child_process.exec`). It uploads local note attachments to cloud storage through a user-configured shell command, then rewrites the note's local links to the returned network URLs. Three trigger paths: manual command/ribbon button, paste/drag handlers, and auto-upload on vault file modify (when `autoUploadOnSave` is on).

## Conventions & gotchas

- **i18n**: `src/lang/helpers.ts` exposes `t(key)`. Every user-facing string must be added to **both** `lang/locale/en.ts` and `lang/locale/zh-cn.ts`, using English keys as the canonical names.
- **Upload command contract**: the command is run with `child_process.exec`; the literal `%s` token is replaced by the double-quoted, escaped file path. A custom command **must print the resulting URL to stdout** (typically the only content on its line). `UploadService.extractUrl` captures from `http(s)://` to end-of-line and trims surrounding quotes (so a URL may contain spaces/parentheses); `toMarkdownUrl` wraps the URL in `<...>` whenever it contains space/paren/angle-bracket characters so bare `![]()` links don't break. This contract is surfaced in the README and settings description.
- `uploadFileFormat` is a `Set` in memory, serialized to/from a comma-joined string only in `main.ts`'s `loadSettings`/`saveSettings`.
- Images vs. non-images are split by extension regex (`avif|bmp|gif|jpeg|jpg|png|svg|webp`); images produce `![]()` links, others `[]()` links.
- `UploadService` methods accept narrow duck-typed `app`/`editor` shapes (not the full Obsidian types) in several places — keep that pattern when extending.
- `require("node:os"|"node:path"|"node:fs")` inside `saveTempFile` is acceptable because the plugin is desktop-only.

## Commands

Uses `bun` (lockfile `bun.lock`); `npm` works identically. Scripts in `package.json`:

```bash
npm run dev       # node esbuild.config.mjs  (watch mode, rebuilds main.js on change)
npm run build     # tsc -noEmit -skipLibCheck && node --no-warnings esbuild.config.mjs production
npm run version   # node version-bump.mjs + git add  (bump manifest.json/versions.json)
npm test          # vp test run
npm check         # vp check --fix
```

## Release process

Tagging a commit triggers `.github/workflows/main.yml`, which builds and drafts a GitHub release containing `main.js`, `manifest.json`, and `styles.css`. Run `npm run version` to bump `manifest.json`/`versions.json` before tagging. `main.js` is git-ignored.

## Coding Standards

General coding standards for this repository.

- **Type safety**: Annotate function parameter/return types explicitly when it improves clarity; use `unknown` instead of `any` for unknown types; mark immutable values with `as const`; prefer type narrowing over type assertions; avoid magic numbers — extract them into named constants.
- **Modern syntax**: Prefer `const`; use `let` only when reassignment is needed; never use `var`; use arrow functions for callbacks; prefer `for...of` over `.forEach()`/indexed `for`; use `?.`/`??`, template strings, and destructuring.
- **Async**: Always `await` and consume the return value inside async functions; prefer `async/await` over promise chains; handle errors with `try-catch`.
- **Error handling**: Remove `console.log`/`debugger`/`alert` from production code; throw `Error` objects (with a description) rather than strings; `try-catch` must be meaningful (no empty catch that re-throws as-is); use early return in error branches to reduce nesting.
- **Code organization**: Keep functions focused and control cognitive complexity; extract complex conditions into named boolean variables; prefer early return and avoid nested ternaries; separate concerns.
- **Security**: Links with `target="_blank"` must add `rel="noopener"`; avoid `dangerouslySetInnerHTML`; never use `eval()` or write `document.cookie` directly; validate/sanitize user input.
- **Performance**: Avoid spread in loop accumulators; hoist regexes to the top level; prefer named imports over namespace imports.
- **Testing discipline**: Write assertions inside `it()`/`test()`; use `async/await` for async tests instead of `done` callbacks; never commit code with `.only`/`.skip`; keep test suites flat and avoid excessive `describe` nesting.
