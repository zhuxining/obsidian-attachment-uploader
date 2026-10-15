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

## Credits

- Inspired by [typora](https://typora.io/) image upload functionality
