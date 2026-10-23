# Compatibility

Requires Obsidian Desktop **1.14.4 or later**. Upload commands run as local executables, so mobile devices are not supported.

# obsidian-attachment-uploader

This Obsidian plugin helps you upload local attachments to cloud storage. You can customize the upload command and specify which attachment formats to upload.

[中文文档](README_ZH.md)

## Features

- Custom upload commands
  - Built-in [uPic](https://github.com/gee1k/uPic) upload command: `/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s`
  - Built-in [Picsee](https://picsee.chitaner.com/blog/Picsee_imageClound_command.html) upload command: `"/Applications/Picsee.app/Contents/MacOS/Picsee -u %s"`
- Customizable attachment formats to upload
- Supports standard Markdown images and Wiki embeds, excluding code, comments and raw HTML
- Optional source deletion after upload, disabled by default; respects Obsidian's trash preference and retains files when references remain or checks are uncertain
- Automatic uploads are on by default for pasted screenshots and pasted/dropped files; failures fall back to local attachments
- If local fallback also fails or a cloud upload succeeds but its link cannot be inserted, a notice shows the recovery location or URL
- Optional inclusion of remote HTTP(S) images in pasted Markdown, disabled by default
- Manually transfers remote HTTP(S) images in the current note
- Batch migration: scan Markdown notes, review the scope, then upload referenced local attachments and remote images; open notes are skipped and local source files are kept
- Skips uploaded results remembered during this session and optional configured URL prefixes

## Installation

1. In Obsidian, open the plugin manager
2. Search for "obsidian-attachment-uploader"
3. Click "Install", then enable and configure after installation

## Configuration

1. Install an image hosting tool with a command-line interface, or prepare a custom upload executable
2. Configure the Obsidian attachment uploader plugin

- **Upload Command**: Include exactly one standalone `%s` argument for the local attachment path. Direct shell pipelines and variable expansion are unsupported; use a trusted executable wrapper if needed. Built-in uPic and Picsee commands need no script.
- **Attachment Formats to Upload**: Configure which attachment formats to upload, separated by commas or line breaks
- **Delete Original After Upload**: Enable optional source deletion after the attachment link is successfully replaced
- **Auto upload**: on by default for pasted screenshots and pasted/dropped files. When off, Obsidian inserts them normally
- **Include remote images**: off by default. When automatic uploading is enabled, also transfer HTTP(S) images in pasted Markdown. Disabling the main switch disables this option while retaining its value
- **Remote image URL prefixes to skip**: optional, one HTTP(S) prefix per line. Matching requires the same protocol, exact host, port and path directory

3. Custom command examples

- uPic command: `/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s`
- stdout must provide a single distinct HTTP(S) destination URL, optionally labelled `Output URL:`; multiple different results are rejected.
- Example output:
  ```text
  Uploading ...
  Uploading 1/1
  Output URL:
  https://example.com/image.png
  ```

Settings are grouped into **Upload tool**, **Upload options** and **Skip rules**. The command editor appears only for custom tools. Expand **Test upload** to upload a local file and check the result; the test path is not saved.

Editing existing vault attachments does not trigger uploads. Use the manual command to upload modified attachments. Allowed formats may include PDF, audio and other extensions; remote transfer handles images only.

## Usage

1. Open a note containing attachments in Obsidian
2. Run `Upload attachments in current note` from the command palette, or click the upload Ribbon button
   This command uploads local attachments and transfers remote HTTP(S) images in the current note. Remote images are processed first so newly uploaded local attachments are not transferred again.
3. Enable both **Auto upload** and **Include remote images** to transfer pasted Markdown images automatically. Rich clipboard content keeps Obsidian’s original paste behaviour
4. To migrate the whole vault, run `Migrate vault attachments`. Choose **Scan vault**, review the number of notes and attachments, then choose **Start migration**; the task can be paused, resumed or cancelled

Batch migration only processes attachments referenced by Markdown notes and never uploads unreferenced vault files. You can exclude folders. Open notes are skipped; close them and scan again. Items are processed in order with a 200 ms interval. The task pauses after three consecutive failures or when an image server returns a rate-limit response. Before writing, the note content and local attachment state are checked again; anything that cannot be confirmed keeps its original link. Successful uploads that cannot be applied receive recovery records, and local source files are always kept. Closing the migration panel leaves the task running; quitting Obsidian stops it without saving progress.

Remote image transfers use fixed limits: 100 unique URLs per operation, 3 concurrent downloads, 20 MiB per image, 200 MiB per batch, 30 seconds per download and 3 redirects.

## Limits, conditions and defaults

### Environment and default settings

| Item                                  | Default / limit                                                   |
| ------------------------------------- | ----------------------------------------------------------------- |
| Obsidian                              | Desktop 1.14.4 or later; mobile is not supported                  |
| Upload tool                           | uPic                                                              |
| Upload command                        | Follows the selected preset; empty for a custom tool              |
| Allowed file types                    | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.avif`, `.bmp` |
| Delete local attachments after upload | Off                                                               |
| Auto upload                           | On                                                                |
| Include remote images                 | Off                                                               |
| Skip URL prefixes                     | Empty                                                             |

### Upload command

- Include exactly one standalone `%s` placeholder; the executable itself must not contain `%s`.
- The command runs directly, without a shell; pipelines, redirects and variable expansion need a trusted wrapper script.
- Each command times out after 20 minutes; standard output is read up to 1 MiB.
- It must return one destination HTTP(S) URL. Results labelled `Output URL:`, `Uploaded:`, `result:` or `URL:` take priority (case-insensitive, inline or on the next line); otherwise a standalone URL line is used. Multiple different candidates at the selected priority fail the upload; identical repeats are accepted; URLs inside prose are ignored.
- Surrounding quotes are trimmed; URLs containing parentheses are wrapped in `<...>` in Markdown.

### Current-note upload and paste/drop

- Only attachments whose extension is allowed and whose reference resolves to a vault file are uploaded; an unresolved or ambiguous same-named file keeps its original link.
- The manual command ignores the auto-upload switch; auto upload only controls pasted screenshots and pasted or dropped files.
- Rich clipboard content (`text/html`) is left to Obsidian; if any file in a batch has a disallowed extension, the whole batch is left to Obsidian.
- Pasted or dropped files are written to the system temporary directory before upload; on failure they are saved to the vault, and if that also fails a recovery copy is written to `~/.obsidian-attachment-uploader-recovery/attachment-*/` (directories `0700`, files `0600`).
- If an upload succeeds but its link cannot be updated, the URL is written to `~/.obsidian-attachment-uploader-recovery/upload-*/receipt.json` (directories `0700`, files `0600`) and a notice is shown.
- Upload commands run one at a time; an in-flight upload is reused only for the same file, command and cancellation scope.
- Repeated clicks on the same note reuse one task; switching notes stops subsequent work.
- Cancelling prevents commands that have not started; a running command may finish, and its unapplied URL receives a recovery record.

### Deleting local attachments (when enabled)

- Deletion happens only after links are replaced and no other reference is found, and follows Obsidian's trash preference.
- Reference checks are bounded to 128 on-disk Markdown/Canvas files, 4 Mi UTF-16 code units in total and 100 ms, yielding every 16 files; a single text above 256 Ki code units is retained without scanning.
- Before deletion, the file path, object identity, size, modification time and open references are checked again; any mismatch retains the file.
- Timeouts, read or parse failures retain the file; checks and deletion are not atomic.

### Remote images (current-note upload and automatic paste)

- Only HTTP(S) images referenced by Markdown are processed; ordinary remote attachments are not downloaded. URLs with a username or password are rejected, including after each redirect.
- Per operation (one note or one paste): at most 100 unique URLs, 20 MiB per image, 200 MiB in total, 30 seconds per image and 3 redirects.
- Up to 3 images download concurrently; batch migration uses 1.
- More than 100 unique URLs skips the whole remote phase and keeps the original links.
- The format is detected from file content; non-image content such as a login page fails, and a type outside the allowed list is skipped.
- Configured URL prefixes and URLs uploaded in this session are skipped; at most 2000 session URLs are remembered. A prefix requires the same protocol, host, port and path directory.
- Before writing, the references must be unchanged and the note must not have switched; otherwise the original links stay and uploaded URLs receive recovery records.

### Batch migration

- Scans every Markdown note in the vault, minus excluded folders; only referenced attachments are processed, and unreferenced files are never uploaded. Scanning has no note or time cap, yields every 16 notes and can be cancelled.
- Only note links change; local source files are always kept, regardless of the delete-after-upload setting.
- Open notes are skipped; previewing never uploads or modifies content.
- Each item waits 200 ms (between notes, between images and around uploads); the task pauses after 3 consecutive failures or when an image server returns 429.
- Remote limits apply per note: 100 unique URLs, 20 MiB per image, 200 MiB in total, 30 seconds per image and 3 redirects, with 1 concurrent download. A note above 100 unique URLs skips its whole remote phase; its local attachments are still processed.
- Across notes, a local path is uploaded once while its size and modification time stay unchanged, and a remote source URL is uploaded once.
- A note is written only when its content, file identity and open state are unchanged; local attachment size and modification time are rechecked after upload and before replacement. Any change keeps the original link.
- A failed item does not stop later items; uploaded URLs that were not written receive recovery records.
- Closing the panel leaves the task running; quitting Obsidian stops it without saving progress, so the next run needs a fresh scan.
- The panel shows the last 100 results while copying includes all entries; the preview lists at most 20 notes.

## Credits

- Inspired by [typora](https://typora.io/) image upload functionality

Manual uploading processes only the current document and works regardless of automatic-upload settings. Local attachments and remote images share one progress notice, cancel button and final summary. Cancellation stops subsequent work; running upload commands may finish, and successful unapplied URLs receive recovery receipts. Repeated clicks reuse the active task for that note.

Changing the plugin’s upload service or command resets session upload records and retains manual prefixes. Configure URL prefixes to skip existing hosted images after restarting; otherwise, manually transferring a note may upload those images again. Cancelling a queued upload prevents its command from starting; an already-running upload may finish.
