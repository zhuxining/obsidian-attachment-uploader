# Attachment Uploader 1.2.1 — security and reliability review

Audit baseline: `c3fffe02b299e5d1c001543be721086eb1631556` (2026-10-14). All application TypeScript modules, existing tests, build/release scripts and settings were inspected. This is a source-level review, not a formal third-party audit or proof of release binary equivalence.

## Confirmed defects addressed in this PR

| Priority | Area | Evidence | Remediation |
| --- | --- | --- | --- |
| High | Command execution | `exec(uploadCommand.replace("%s", escapedPath))` interprets shell expansions in quoted filenames | Parse executable/arguments and invoke `execFile` with `shell:false`, explicit timeout, bounded output |
| High | Attachment deletion | Successful upload alone triggered `vault.delete` even when link updates were incomplete | Require successful editor rewrite, conservative cross-Vault reference check, use trash instead of permanent delete |
| Medium | Clipboard/drop | `preventDefault` occurs before upload, no failure recovery | Reserve a stable marker and fall back to a locally saved Vault attachment |
| Medium | Temporary files | Original filename written directly into global tmp directory without cleanup | Per-upload `mkdtemp`, exclusive write, cleanup in `finally` |
| Medium | Ambiguous filenames | First filename match across the Vault may refer to the wrong folder | Resolve with `metadataCache`, refuse ambiguous matches |
| Medium | Auto upload | Vault `modify` could upload a file merely mentioned by name, and regex might rewrite wrong links | Require resolved embed identity; avoid rewriting ambiguous bare basenames |
| Medium | Release action | Manual tag field interpolated into Shell script | Pass user input through an environment variable |
| Low | Settings | Cached upload service ignored changes until reload | Build lightweight upload service from current settings |
| Low | URL output | First incidental HTTP URL could be treated as uploaded destination | Prefer standalone URLs or explicit uploader output labels; normalize percent encoding |

## Modules and configuration reviewed

- `src/main.ts` — events, lifecycle, settings persistence, temp files and fallback
- `src/attachmentMatcher.ts` — Markdown/Wiki parsing and Vault reference resolution
- `src/services/UploadService.ts`, `command.ts`, `url.ts` — argument safety, upload result handling and URL/link rewriting
- `src/settingsTab.ts` and `src/lang/**` — configuration, help strings and defaults
- `.github/workflows/main.yml`, `esbuild.config.mjs`, `vite.config.ts`, `version-bump.mjs`, `package.json`, `bun.lock` — build and release surfaces
- `tests/**` — unit and regression coverage

## Validation

The fork's GitHub Actions workflow installs dependencies and executes `vp run ci` and `vp test run`. See live checks in the PR; do not equate green CI with macOS/uPic/OSS end-to-end validation.

## Outstanding limitations

1. Regex-based Markdown recognition is not a complete parser. Nested links, escaped unusual paths, encoded variants and non-embed links can remain unmatched; failure should preserve local data.
2. The full-Vault reference scan is conservative and may retain orphaned local attachments. Vaults with many notes may experience overhead when source deletion is enabled.
3. Cloud uploads may create remote orphan objects if the editor marker was removed while the upload was running. Source deletion remains off by default.
4. Release asset provenance and published bundled `main.js` have not been independently verified; no live uPic/Alibaba OSS upload was executed.
5. Only known/tested uploader output formats are supported; custom commands using shell pipelines need an executable wrapper.

## Manual acceptance matrix (not yet completed)

- [ ] macOS Obsidian screenshot paste, uPic image upload to Alibaba OSS, correct URL and preview
- [ ] Image names with spaces, Chinese, parentheses, `$`, quotes and backticks
- [ ] Drag/drop MP4, MP3 and PDF to Obsidian, verify object and Markdown
- [ ] Simulate failed uploader, verify local fallback and no attachment loss
- [ ] Same basename in two folders; verify correct attachment selection and no wrong replacements
- [ ] Multiple open notes sharing one attachment; original must be preserved
- [ ] Enable deletion for a disposable file, confirm it reaches Obsidian trash only when safe
- [ ] Change command and formats in settings without restarting Obsidian
- [ ] Test auto-upload only with actual metadata-resolved embeds

## Disclosure / safety posture

The upstream repository contains the vulnerable patterns described here. This change set is intended as a security hardening PR; do not describe the original behavior as an exploited vulnerability without supporting evidence.
