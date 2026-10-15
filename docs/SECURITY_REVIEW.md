# Attachment Uploader 1.3.0 — security and reliability review

**Review status: Completed (2026-10-15).** Source review, implementation remediation and automated regression validation are complete. All findings below are resolved within their documented boundaries; no implementation findings remain open in this review. Desktop/cloud manual acceptance and release verification remain pending as listed below.

Audit baseline: `c3fffe02b299e5d1c001543be721086eb1631556` (2026-10-14). All application TypeScript modules, existing tests, build/release scripts and settings were inspected. This is a source-level review, not a formal third-party audit or proof of release binary equivalence.

Status reconciled against the current 1.3.0 source on 2026-10-15. **Resolved** means a source-level fix exists; **Accepted — no fix planned** means a documented design limitation; **Open** means an implementation gap remains; **Pending verification** requires runtime or release evidence.

## Original findings: current status

| Finding                               | Status                                  | Current evidence and remaining scope                                                                                                                                                    |
| ------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command execution                     | **Resolved**                            | `command.ts` uses parsed arguments, exactly one standalone `%s`, `execFile`, `shell:false`, a timeout and bounded output. The configured executable remains trusted user configuration. |
| Attachment deletion                   | **Resolved with documented boundaries** | Successful rewrite, all loaded Markdown views plus disk Markdown/Canvas scanning, file-state checks and preference-respecting trash; non-atomic limits remain documented in O2.         |
| Clipboard/drop recovery               | **Resolved with documented boundaries** | Vault fallback, then a recovery copy under the user's home directory; if all three storage paths fail, retain any existing temporary copy subject to OS cleanup; see O1.                |
| Temporary file isolation and cleanup  | **Resolved**                            | Per-upload `mkdtemp`, sanitized filenames and exclusive writes. Cleanup runs after successful cloud, Vault or recovery persistence; see O1 for failure retention.                       |
| Ambiguous filenames                   | **Resolved**                            | Metadata resolution is authoritative; unresolved links are preserved and ambiguous basename fallback is refused.                                                                        |
| Auto upload and replacement           | **Resolved**                            | Requires metadata-resolved embeds and re-resolves current editor content before replacing references to the uploaded file.                                                              |
| Release action shell interpolation    | **Resolved**                            | Tag input passes through an environment variable and quoted shell use, rather than interpolation into shell source.                                                                     |
| Settings changes ignored until reload | **Resolved**                            | Service construction reads current settings. Already-running commands keep their original configuration.                                                                                |
| URL output selection                  | **Resolved with documented boundaries** | Explicitly labelled results take precedence over standalone URLs; distinct candidates at the selected priority cause failure; see O3.                                                   |

The following table records the original defects and remediation intent; the status table above determines whether each finding is fully resolved.

| Priority | Area                | Evidence                                                                                         | Remediation                                                                                                        |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| High     | Command execution   | `exec(uploadCommand.replace("%s", escapedPath))` interprets shell expansions in quoted filenames | Parse executable/arguments and invoke `execFile` with `shell:false`, explicit timeout, bounded output              |
| High     | Attachment deletion | Successful upload alone triggered `vault.delete` even when link updates were incomplete          | Require successful editor rewrite, conservative cross-Vault reference check, use trash instead of permanent delete |
| Medium   | Clipboard/drop      | `preventDefault` occurs before upload, no failure recovery                                       | Reserve a stable marker and fall back to a locally saved Vault attachment                                          |
| Medium   | Temporary files     | Original filename written directly into global tmp directory without cleanup                     | Per-upload `mkdtemp`, exclusive write, cleanup in `finally`                                                        |
| Medium   | Ambiguous filenames | First filename match across the Vault may refer to the wrong folder                              | Resolve with `metadataCache`, refuse ambiguous matches                                                             |
| Medium   | Auto upload         | Vault `modify` could upload a file merely mentioned by name, and regex might rewrite wrong links | Require resolved embed identity; avoid rewriting ambiguous bare basenames                                          |
| Medium   | Release action      | Manual tag field interpolated into Shell script                                                  | Pass user input through an environment variable                                                                    |
| Low      | Settings            | Cached upload service ignored changes until reload                                               | Build lightweight upload service from current settings                                                             |
| Low      | URL output          | First incidental HTTP URL could be treated as uploaded destination                               | Prefer standalone URLs or explicit uploader output labels; normalize percent encoding                              |

## Modules and configuration reviewed

- `src/main.ts` — events, lifecycle, settings persistence, temp files and fallback
- `src/attachmentMatcher.ts` — Markdown/Wiki parsing and Vault reference resolution
- `src/services/uploadService.ts`, `src/services/command.ts`, `src/services/url.ts` — argument safety, upload result handling and URL/link rewriting
- `src/services/uploadReceipts.ts` — private recovery receipts for successful cloud uploads whose links could not be applied
- `src/settingsTab.ts` and `src/lang/**` — configuration, help strings and defaults
- `.github/workflows/main.yml`, `vite.config.ts`, `version-bump.mjs`, `package.json`, `bun.lock` — build and release surfaces; Vite Plus / Rolldown builds a single CommonJS artifact in `dist/` and copies `main.js` to the root after each successful build, including watch rebuilds
- `tests/**` — unit and regression coverage

## Validation

**Automated validation:** regression coverage includes standard Markdown/Wiki matching, conservative scan budgets, unapplied-upload receipts and real executable wrappers. The wrapper tests use temporary executable paths with spaces and attachment names containing Chinese characters, newlines, `$()` and backticks; they verify literal argument delivery, stdout URL/stderr separation and rejection of a nonzero exit even when stdout contains a URL. These POSIX shell tests are conditionally skipped on Windows. Earlier artifact checks exercised CommonJS export shape, external host/Node dependencies, development inline source maps and root artifact synchronization. Local validation does not establish desktop/cloud runtime evidence.

**Pending verification:** current remote CI results, release asset provenance and equivalence of published `main.js` to reviewed source. No live uPic/Alibaba OSS upload was executed. Local checks do not replace desktop/cloud acceptance testing.

## Additional safeguards — resolved

**Resolved at source level:** the declared compatibility baseline is Obsidian Desktop 1.14.4. Editor replacements use `Editor.transaction`; local source removal uses `FileManager.trashFile` to respect trash preferences. Already-handled paste/drop events and deferred views are skipped. Paste/drop results locate the original marker in the editor or source note, using `Vault.process` when the source note no longer has a loaded editor. Manual upload stops editing a view if its source file changes during upload. Actual host compatibility and trash behavior remain pending manual verification.

**Resolved within supported syntax:** paste/drop batches reserve all insertion markers before starting uploads. A batch containing unsupported formats is left entirely to Obsidian's default handling. Manual uploads group references by resolved file path, and service instances share in-flight command results. Fenced code, backtick code spans and HTML comments are excluded from attachment matching; replacement uses matched offsets rather than global string substitution. Metadata-backed matching does not enumerate Vault files; deletion scanning still does.

**Resolved:** link replacement uses the same attachment matcher for manual and automatic uploads. When metadata resolution is available, its result for the source note is authoritative: an unresolved link is preserved rather than redirected by a basename fallback. Automatic replacement re-resolves current editor content after upload and changes only embeds targeting the uploaded file. Paste/drop failure recovery retains the initiating note path throughout the asynchronous operation.

## Follow-up findings — resolved with documented boundaries

| ID  | Status                                  | Remaining issue and required outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | **Resolved with documented boundaries** | If cloud upload and Vault persistence fail, `main.ts` attempts a recovery copy in `~/.obsidian-attachment-uploader-recovery/attachment-*/`. The recovery root is created with mode `0700`, each unique directory is private, and files are exclusively created with mode `0600`; an existing root's permissions are not reset. A persistent notice reports the recovery path. If cloud, Vault and home recovery all fail, any existing temporary copy is retained and its directory reported. The OS may clean temporary storage; this last resort is not guaranteed durable recovery, and a failure before the temporary copy is written can leave no copy.                                                                                                                                                                                   |
| O2  | **Resolved with documented boundaries** | Deletion scanning checks every loaded, non-deferred Markdown view independently, including multiple views of one note, plus disk Markdown/Canvas content via `Vault.cachedRead`. Percent decoding is bounded and conservative; unresolved percent escapes, HTML entities, scan/read/parse failures and possible references retain the file. Before trashing, the service rechecks open views, path/object identity and adapter `stat` type, size and mtime against the pre-upload snapshot; missing or changed state prevents removal. Scanning and trashing remain non-atomic: concurrent edits after checks and content changes with identical size/mtime cannot be guaranteed detectable. These concurrency limits are accepted; source deletion remains disabled by default and uses `FileManager.trashFile` to respect trash preferences. |
| O3  | **Resolved with documented boundaries** | `url.ts` prefers valid HTTP(S) results labelled `Output URL`, `Uploaded`, `result` or `URL` (case-insensitive, inline after a colon or on the following line) over standalone URL lines. At the selected priority, exactly one distinct candidate is required; repeated identical candidates are allowed, but different results fail the upload. With no valid labelled result, the same single-result rule applies to standalone URLs. Incidental prose is ignored. Custom commands must follow this contract; the parser cannot establish that a unique returned URL identifies the intended uploaded object.                                                                                                                                                                                                                                |

## Follow-up findings A1–A4 — implementation results

**A1 — Resolved within supported syntax.** `attachmentMatcher.ts` uses `mdast-util-from-markdown` for the complete standard Markdown image syntax, including inline and full/collapsed/shortcut reference images, nested/escaped syntax and definitions. Wiki embeds are merged by source offset while excluding standard image ranges, definitions, code, comments and raw HTML regions. Tests cover mixed syntax and UTF-16 offsets. This does not claim support for all Obsidian syntax extensions or ordinary non-image links. Unresolved references remain unchanged; deletion safety uses the separate conservative scan in O2/A2.

**A2 — Resolved with documented boundaries.** `uploadService.ts` bounds disk scanning to 128 Markdown/Canvas files, 4 Mi (4,194,304) UTF-16 code units in total and 100 ms elapsed time, yielding to the event loop every 16 files. A single text above 256 Ki (262,144) code units causes retention before reference normalization. Open-view checks separately use a 4 Mi code-unit and 100 ms budget. Budget exhaustion, uncertain references and read/parse failures retain the source; the next operation reads again rather than trusting a metadata-only scan cache. Time checks cannot preempt an in-progress read or synchronous work. Large Vaults can retain unused files; O2's non-atomic concurrency boundaries remain.

**A3 — Resolved with documented boundaries.** Successful cloud results that cannot be applied to the initiating note/editor are preserved through `preserveUploadReceipt` in manual, automatic and paste/drop paths. `~/.obsidian-attachment-uploader-recovery/upload-*/receipt.json` contains `URL`, `sourcePath`, `filename` and `timestamp` for manual recovery. Receipt handling enforces mode `0700` on the root and unique directory and `0600` on the exclusively created file. Persistent notices show the receipt path and URL; write failure still reports the URL and error. This records a recovery result, not an attachment backup or automatic retry. Remote objects are not deleted.

**A4 — Resolved with documented boundaries.** `shell:false` is intentional: upload commands invoke an executable directly with arguments, without shell pipelines or variable expansion. Built-in presets require no separate wrapper setup. Real executable integration tests cover spaced paths, hostile filename characters, stdout/stderr separation and nonzero exits. Provider output still must satisfy O3, and live uPic/cloud acceptance remains pending.

## Manual acceptance matrix — pending verification

All unchecked items remain **Pending verification**, even where simulated tests cover part of the behavior.

- [ ] macOS Obsidian screenshot paste, uPic image upload to Alibaba OSS, correct URL and preview
- [ ] Image names with spaces, Chinese, parentheses, `$`, quotes and backticks
- [ ] Enable the relevant formats, then drag/drop MP4, MP3 and PDF; verify object and Markdown
- [ ] Simulate failed uploader; verify successful local fallback and attachment persistence
- [ ] Simulate cloud and Vault persistence failures; verify the home recovery copy, reported path and permissions; also simulate recovery failure and verify temporary-copy retention subject to OS cleanup
- [ ] Same basename in two folders; verify correct attachment selection and no wrong replacements
- [ ] Multiple notes and views sharing one attachment, including unsaved references; verify preservation within O2's documented concurrency boundaries
- [ ] Enable deletion for a disposable file; verify configured Vault/system trash behavior and preservation when references remain
- [ ] Change command and formats in settings without restarting Obsidian
- [ ] Test auto-upload only with actual metadata-resolved embeds

## Disclosure / safety posture

The original audit baseline contained the vulnerable patterns described here. This change set provides security hardening; it is not evidence of exploitation. Source-level resolution, documented boundaries, accepted limitations and pending verification must not be described collectively as fully verified.
