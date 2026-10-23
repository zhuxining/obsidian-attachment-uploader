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
- Automatically uploads files pasted or dragged from outside Obsidian, falling back to local attachments if upload fails
- If local fallback also fails or a cloud upload succeeds but its link cannot be inserted, a notice shows the recovery location or URL
- The auto-upload setting only controls uploads triggered by modifications to existing local attachments
- Transfers remote HTTP(S) images referenced by Markdown into the configured host: whole note, selection or one image from the editor context menu
- Optional Markdown paste policy (`off`, `ask`, `auto`) for text containing remote images; the pasted text is inserted unchanged
- Skips links that already use the configured image host, and can force a single-image re-upload on demand
- On macOS, reads only the current default uPic host's public URL prefix; Picsee/custom commands can use manual prefixes or a suggested prefix from an earlier successful upload

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
- **Auto Upload**: Upload existing local attachments when they are modified; pasting and dragging upload independently of this setting
- **Remote image paste policy**: `off` keeps Obsidian's original paste behaviour; `ask` inserts the text and offers one action for this paste; `auto` transfers the pasted range immediately
- **Automatically detect the current image host**: only available for uPic on macOS; reads the default host's public URL prefix without reading or showing configuration secrets
- **Remote image URL prefixes to skip**: one HTTP(S) prefix per line. Matching requires the same protocol, exact host, effective port and path directory; shared hosts such as `raw.githubusercontent.com` require an account/repository path
- **Insert suggested prefix**: derives a reviewable prefix from the last successful upload URL; it is not saved until you keep it

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

## Usage

1. Open a note containing attachments in Obsidian
2. Press `command+p` to open the command palette and type `Upload editor attachments`, or use the Ribbon button
3. To transfer remote images, use `Transfer remote images in current note`, `Transfer remote images in selection`, or right-click an image in the editor for `Transfer this image` / `Force re-upload this image`
4. Pasting Markdown text follows the remote image paste policy. In `ask` mode, the text is inserted immediately and a notice offers to transfer only that pasted range

Remote image transfer limits can be changed in the plugin settings under **Remote images**. Defaults: at most 100 unique URLs per operation, 3 concurrent downloads, 20 MiB per image, 200 MiB per batch, 30 seconds per download and 3 redirects. Enter positive integers; redirects also accept 0 to disable following redirects. Changes apply to the next operation. Existing installations use these defaults until changed.

## Credits

- Inspired by [typora](https://typora.io/) image upload functionality

Within one batch, identical URLs are downloaded/uploaded once. Different notes transfer independently; remote-transfer upload commands run through one serial queue. Repeated clicks on the same operation reuse the task. Original image references are tracked through editor transactions: deleted/edited references, file switches or uncertain identities stop replacement and successful unapplied URLs receive recovery receipts.

Changing the plugin's upload service/command or detecting a changed uPic host clears session records and prefix suggestions. Late old jobs cannot repopulate the new records; manual prefixes are retained. After switching hosts inside Picsee or a custom uploader, use **Clear session records** in settings. Cancelling a queued upload prevents its command from starting; an already-running upload may finish.
