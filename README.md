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
- **Attachment Formats to Upload**: Configure which attachment formats to upload, separated by commas or line breaks. Manual uploads, paste/drop, remote image transfers and batch migration all use this filter; the test upload in settings ignores it
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

## Limits and defaults

### Defaults

| Item                                  | Default                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| Upload tool                           | uPic                                                      |
| Allowed file types                    | Image formats (png, jpg, jpeg, gif, webp, svg, avif, bmp) |
| Auto upload                           | On                                                        |
| Include remote images                 | Off                                                       |
| Delete local attachments after upload | Off                                                       |
| Skip URL prefixes                     | Empty                                                     |

### Upload conditions

- Only allowed file types that resolve to a vault file are uploaded; an unresolved or ambiguous reference keeps its original link.
- “Allowed file types” applies to manual uploads, paste/drop, remote image transfers and batch migration. Remote images are judged by their downloaded content, and excluded types keep their original links during batch migration. The test upload in settings ignores this setting.
- The manual command ignores the auto-upload switch; auto upload only handles pasted screenshots and pasted or dropped files.
- Rich clipboard content and batches containing a disallowed file type are left to Obsidian.
- If an upload fails, a pasted or dropped file is saved to the vault; if that also fails, a copy is saved under `~/.obsidian-attachment-uploader-recovery/` and the path is shown.
- Upload commands run one at a time and each times out after 20 minutes; the command must return one destination URL.

### Remote images

Each operation allows up to 100 unique URLs, 20 MiB per image, 200 MiB in total, 30 seconds per image and 3 redirects. Manual upload downloads 3 at a time; batch migration uses 1. Above 100 unique URLs the whole remote phase is skipped and the original links stay. URLs uploaded in this session and configured prefixes are skipped.

### Deleting local attachments

Delete only after links are replaced and no other reference is found, following Obsidian's trash preference. Keep the file when checks time out or cannot be confirmed.

### Batch migration

- Scans all Markdown notes, minus excluded folders, and only processes referenced attachments; unreferenced files are never uploaded.
- Open notes are skipped; local source files are always kept.
- Each item waits 200 ms; the task pauses after 3 consecutive failures or when an image server rate-limits.
- Remote limits apply per note; a note above 100 unique URLs skips its remote phase while local attachments still migrate.
- Before writing, note content and local attachments are checked again; anything uncertain keeps its original link.
- Closing the panel leaves the task running; quitting Obsidian stops it without saving progress.

## Credits

- Inspired by [typora](https://typora.io/) image upload functionality

Manual uploading processes only the current document and works regardless of automatic-upload settings. Local attachments and remote images share one progress notice, cancel button and final summary. Cancellation stops subsequent work; running upload commands may finish, and successful unapplied URLs receive recovery receipts. Repeated clicks reuse the active task for that note.

Changing the plugin’s upload service or command resets session upload records and retains manual prefixes. Configure URL prefixes to skip existing hosted images after restarting; otherwise, manually transferring a note may upload those images again. Cancelling a queued upload prevents its command from starting; an already-running upload may finish.
