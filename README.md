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

Remote image transfers use fixed limits: 100 unique URLs per operation, 3 concurrent downloads, 20 MiB per image, 200 MiB per batch, 30 seconds per download and 3 redirects.

## Credits

- Inspired by [typora](https://typora.io/) image upload functionality

Manual uploading processes only the current document and works regardless of automatic-upload settings. Local attachments and remote images share one progress notice, cancel button and final summary. Cancellation stops subsequent work; running upload commands may finish, and successful unapplied URLs receive recovery receipts. Repeated clicks reuse the active task for that note.

Changing the plugin’s upload service or command resets session upload records and retains manual prefixes. Configure URL prefixes to skip existing hosted images after restarting; otherwise, manually transferring a note may upload those images again. Cancelling a queued upload prevents its command from starting; an already-running upload may finish.
