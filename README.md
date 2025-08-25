# obsidian-attachment-uploader

This Obsidian plugin helps you upload local attachments to cloud storage. You can customize the upload shell command and specify which attachment formats to upload.

[中文文档](README_ZH.md)

## Features

* Custom shell command for uploading
  * Built-in [uPic](https://github.com/gee1k/uPic) upload command: `/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s`
  * Built-in [Picsee](https://picsee.chitaner.com/blog/Picsee_imageClound_command.html) upload command: `"/Applications/Picsee.app/Contents/MacOS/Picsee -u %s"`
* Customizable attachment formats to upload
* Option to delete original attachments after upload
* Automatic upload when pasting or dragging from outside Obsidian

## Installation

1. In Obsidian, open the plugin manager
2. Search for "obsidian-attachment-uploader"
3. Click "Install", then enable and configure after installation

## Configuration

1. Install an image hosting tool (with shell upload command) or create a custom shell upload command
2. Configure the Obsidian attachment uploader plugin:
   - **Upload Command**: Configure the shell command for uploading attachments
   - **Attachment Formats to Upload**: Configure which attachment formats to upload (separated by line breaks)
   - **Delete Original After Upload**: Configure whether to delete original attachments after upload
3. Custom command examples:
   - uPic shell execution command: `/Applications/uPic.app/Contents/MacOS/uPic -o url -u /local.png`
   - Shell output format:
     ```
     Uploading ...
     Uploading 1/1
     Output URL:
     https://r-w.oss-cn-shanghai.aliyuncs.com/uPic/Snipaste_2024-08-18_22-14-14.png?x-oss-process=image/auto-orient,1/quality,q_80/format,webp
     ```
   - This plugin uses `%s` to replace the local image path and extracts the image URL from shell output using `urlMatch = stdout.match(/\s+(https?:\/\/\S+)/)`
   - Therefore, the uPic command should be: `/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s`
   - If writing your own upload script, make sure to print the uploaded image's network URL in the shell output

## Usage

1. Open a note containing attachments in Obsidian
2. Press `command+p` to open the command palette and type `Upload editor attachments`, or use the Ribbon button

## Credits

* Inspired by [typora](https://typora.io/) image upload functionality