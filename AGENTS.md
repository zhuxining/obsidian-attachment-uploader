# AGENTS.md

This file provides guidance to AGENTS Code when working with code in this repository.

## Overview

Obsidian **desktop-only** plugin (`isDesktopOnly: true` in `manifest.json`, because it runs local executables via `child_process.execFile` with `shell:false`). It uploads local note attachments to cloud storage through a user-configured executable command, then rewrites the note's local links to the returned network URLs. Two trigger paths: the current-note command/ribbon uploads local attachments and transfers remote Markdown images; paste/drop handlers run when `autoUpload` is on (default true), with pasted remote images additionally gated by `autoTransferRemoteImages` (default false). Existing vault file modifications do not trigger uploads.

`main.ts` registers the Obsidian lifecycle and forwards events to `uploadWorkflow.ts`. The workflow owns per-note jobs, editor tracking and session records; `fileInsertion.ts` owns pasted/dropped file insertion and local recovery. All paths share one `Uploader` instance, whose internal queue serializes external processes. Queued jobs may be cancelled; running commands return their results for application or recovery.

## Conventions & gotchas

- **i18n**: `src/lang/helpers.ts` exposes `t(key)`. Every user-facing string must be added to **both** `lang/locale/en.ts` and `lang/locale/zh-cn.ts`, using English keys as the canonical names.
- **Upload command contract**: `upload/uploader.ts` parses executable/arguments and uses `child_process.execFile` with `shell:false`, a timeout and bounded output. Exactly one standalone `%s` argument is replaced by the file path; shell expansion and pipelines require a trusted executable wrapper. A custom command **must print one destination URL to stdout**. `extractUrl` in `src/upload/uploader.ts` prefers valid HTTP(S) results labelled `Output URL`, `Uploaded`, `result` or `URL` (case-insensitive, inline after a colon or on the following line); otherwise it uses standalone URL lines. The selected priority must have exactly one distinct candidate; identical repeats are allowed, different results fail, and incidental prose URLs are ignored. Surrounding quotes are trimmed. `toMarkdownUrl` in `attachments/imageRewriter.ts` normalizes percent encoding/Unicode/whitespace and wraps URLs containing parentheses in `<...>` so Markdown links do not break.
- **Attachment parsing**: `attachments/markdown.ts` uses `mdast-util-from-markdown` for standard inline and reference images, then merges Wiki embeds by UTF-16 offsets. Keep code, comments, raw HTML, image ranges and definitions excluded from Wiki scanning. This supports standard image syntax plus Wiki embeds, not every Obsidian extension or ordinary non-image link; `attachments/vaultAttachments.ts` resolves paths through Obsidian metadata, which remains authoritative.
- **Conservative deletion budgets**: `upload/localAttachments.ts` scans at most 128 disk Markdown/Canvas files, 4 Mi UTF-16 code units total and 100 ms elapsed time, yielding every 16 files. Texts above 256 Ki code units retain the source before normalization; open-view checks separately use 4 Mi/100 ms budgets. Exhausted budgets or uncertain/read/parse failures retain the file. Reads are repeated per operation; elapsed-time checks cannot preempt reads or synchronous work, and scan/trash remains non-atomic.
- **Unapplied cloud results**: Manual and paste/drop flows call `preserveUploadReceipt` when a successful upload cannot be applied. It writes `~/.obsidian-attachment-uploader-recovery/upload-*/receipt.json` with `URL`, `sourcePath`, `filename`, `timestamp`, enforcing root/directory mode `0700` and file mode `0600`. Persistent notices report the path and URL, or URL/error if saving fails. Recovery is manual; do not describe receipts as attachment backups or remote-object deletion.
- Manual tasks share one progress notice, cancellation controller and summary per note. Local `processAttachment` returns an upload status for aggregation; a running command may finish after cancellation, in which case its unapplied URL is receipted.
- `uploadFileFormat` is a `Set` in memory, serialized to/from a comma-joined string in `settings.ts`'s `parseSettings`/`serializeSettings`.
- Images vs. non-images are split by extension regex (`avif|bmp|gif|jpeg|jpg|png|svg|webp`); images produce `![]()` links, others `[]()` links.
- Preserve the narrow editor/file shapes used by attachment resolution and local replacement when extending them.

## Commands

Uses `bun` (lockfile `bun.lock`); `npm` works identically. Scripts in `package.json`:

```bash
npm run dev       # vp build --watch --mode development (rebuilds root main.js)
npm run build     # tsc --noEmit && vp build (Rolldown, dist/main.js copied to root)
npm run version   # node version-bump.mjs + git add  (bump manifest.json/versions.json)
npm test          # vp test run
npm check         # vp check --fix
```

## Release process

Tagging a commit triggers `.github/workflows/main.yml`, which builds and drafts a GitHub release containing `main.js`, `manifest.json`, and `styles.css`. Run `npm run version` to bump `manifest.json`/`versions.json` before tagging. `main.js` is git-ignored.

## Coding Standards

General coding standards for this repository.

- **Type safety**: Annotate function parameter/return types explicitly when it improves clarity; use `unknown` instead of `any` for unknown types; mark immutable values with `as const`; prefer type narrowing over type assertions; avoid magic numbers — extract them into named constants.
- **Current APIs**: Use current, non-deprecated APIs supported by the project’s dependency versions and `manifest.json` minimum Obsidian version. Check `@deprecated` declarations and use the recommended replacements; keep `typescript/no-deprecated` enabled in `bun run check` rather than suppressing deprecation warnings.
- **Modern syntax**: Prefer `const`; use `let` only when reassignment is needed; never use `var`; use arrow functions for callbacks; prefer `for...of` over `.forEach()`/indexed `for`; use `?.`/`??`, template strings, and destructuring.
- **Async**: Always `await` and consume the return value inside async functions; prefer `async/await` over promise chains; handle errors with `try-catch`.
- **Error handling**: Remove `console.log`/`debugger`/`alert` from production code; throw `Error` objects (with a description) rather than strings; `try-catch` must be meaningful (no empty catch that re-throws as-is); use early return in error branches to reduce nesting.
- **Code organization**: Keep functions focused and control cognitive complexity; extract complex conditions into named boolean variables; prefer early return and avoid nested ternaries; separate concerns.
- **Security**: Links with `target="_blank"` must add `rel="noopener"`; avoid `dangerouslySetInnerHTML`; never use `eval()` or write `document.cookie` directly; validate/sanitize user input.
- **Performance**: Avoid spread in loop accumulators; hoist regexes to the top level; prefer named imports over namespace imports.
- **Testing discipline**: Write assertions inside `it()`/`test()`; use `async/await` for async tests instead of `done` callbacks; never commit code with `.only`/`.skip`; keep test suites flat and avoid excessive `describe` nesting.
