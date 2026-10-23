export default {
  "Migrate vault attachments": "批量迁移附件",
  "Ready to scan": "等待扫描",
  "Scanning notes...": "正在扫描笔记…",
  "Review migration": "确认迁移范围",
  "Migrating attachments...": "正在迁移附件…",
  "Migration paused": "迁移已暂停",
  "Migration completed": "迁移完成",
  "Migration cancelled": "迁移已取消",
  "Migration stopped": "迁移已停止",
  "The note was open, so it was skipped. Close it and scan again to migrate it.":
    "笔记当时处于打开状态，已跳过。关闭后可重新扫描并迁移。",
  "Note changed during migration; original content was kept.":
    "笔记在迁移期间发生变化，未写入迁移结果。",
  "Note no longer exists.": "笔记已不存在。",
  "A local attachment changed or is unavailable; its link was kept.":
    "本地附件已变化或无法读取，原链接已保留。",
  "Could not read or update this note.": "无法读取或更新此笔记。",
  "An attachment could not be uploaded; its link was kept.": "附件上传失败，原链接已保留。",
  "This note exceeds the remote image limit; remote links were kept.":
    "此笔记的外链图片数量超出限制，外链已保留。",
  "Migration cancelled; remaining links were kept.": "迁移已取消，尚未更新的链接已保留。",
  "No attachments need to be migrated.": "没有需要迁移的附件。",
  Updated: "已更新",
  Failed: "失败",
  Skipped: "跳过",
  "Updated attachments:": "已更新附件：",
  "Skipped duplicate uploads:": "跳过重复上传：",
  "Run “Migrate vault attachments” to view the results.": "执行「批量迁移附件」查看结果。",
  "Run “Migrate vault attachments” to return to this task.": "执行「批量迁移附件」返回任务。",
  "Scans Markdown notes, reviews the scope, then uploads referenced attachments and updates their links. Unreferenced vault files are not uploaded, and local source files are kept.":
    "扫描库内 Markdown 笔记，确认范围后上传笔记引用的附件并更新链接。未在笔记中引用的文件不会上传，本地源文件保留。",
  "Open notes are skipped. You can close this panel while the task runs; quitting Obsidian stops the task, and progress is not saved.":
    "打开的笔记会跳过。任务运行期间可以关闭此窗口；退出 Obsidian 会停止任务，且不保存进度。",
  "Excluded folders": "排除文件夹",
  "One vault-relative folder per line, for example Templates or Attachments/private. Notes and local files in these folders are skipped.":
    "每行填写一个库内文件夹路径，例如 Templates 或 Attachments/private。跳过其中的笔记及本地附件。",
  "Current note:": "当前笔记：",
  "Current attachment:": "当前附件：",
  "The image server requested a pause. Review the results before resuming.":
    "图片服务器返回限流响应，任务已暂停。请稍后查看记录并继续。",
  "Three consecutive operations failed. Check the upload tool and network before resuming.":
    "连续三项操作失败，任务已暂停。请检查上传工具和网络后继续。",
  "Upload settings changed. Scan again before starting a new migration.":
    "上传配置已变化，请重新扫描后开始迁移。",
  "Notes to migrate: {count}": "待迁移笔记：{count}",
  "Local files: {count}": "本地文件：{count}",
  "Remote images: {count}": "外链图片：{count}",
  "Missing local references: {count}. Their links will be kept.":
    "{count} 处本地附件找不到文件，将保留原链接。",
  "Notes that could not be scanned: {count}": "无法扫描的笔记：{count}",
  "Showing the first {count} notes.": "仅显示前 {count} 篇笔记。",
  "Processed notes:": "已处理笔记：",
  "Scan notes": "扫描笔记",
  "Start migration": "开始迁移",
  Resume: "继续",
  Pause: "暂停",
  "Attachments are processed one at a time. A failed upload keeps the original link. Cancelling does not remove files that were already uploaded.":
    "附件按顺序逐个处理。上传失败时保留原链接；取消任务不会删除已经上传的文件。",
  "Migration results": "迁移结果",
  "Copy results": "复制结果",
  "Migration results copied.": "迁移结果已复制。",
  "Could not copy migration results:": "无法复制迁移结果：",
  "Showing the last {count} results. Copy results to include all entries.":
    "仅显示最近 {count} 条记录，复制结果可获取全部记录。",
  "Upload current note attachments": "上传当前笔记的附件",
  "Uploading attachments...": "正在处理附件…",
  "Upload cancelled.": "上传已取消。",
  "Uploaded:": "已上传：",
  "Upload tool": "上传工具",
  Custom: "自定义",
  "Upload command instructions":
    "命令中须保留一个独立的 %s 参数，用于传入文件路径。上传程序须在标准输出中返回一个 HTTP(S) 地址。",
  "Test upload": "上传测试",
  "Testing uploads the selected file to your configured host.": "测试会实际上传指定文件。",
  "Upload options": "上传选项",
  "Automatically upload attachments when pasting or dragging files.":
    "粘贴截图、粘贴或拖入文件时，自动上传并插入链接。",
  "Include remote images": "包含外链图片",
  "Also transfer HTTP(S) images in pasted Markdown text.":
    "开启自动上传后，同时转存粘贴 Markdown 文本中的外链图片。",
  "File extensions separated by commas or line breaks, e.g. .png, .jpg, .pdf. Used by manual uploads, pasted or dropped files, remote image transfers and batch migration; the test upload in settings is not filtered.":
    "填写扩展名，以英文逗号或换行分隔，例如 .png、.jpg、.pdf。手动上传、粘贴或拖入文件、外链转存和批量迁移都会按此过滤；设置页的上传测试不受限制。",
  "Only delete vault source files after replacing links and checking remaining references.":
    "链接替换成功后删除库内原文件；仍有引用或无法确认时保留。",
  "Skip rules": "外链图片",
  "One HTTP(S) URL prefix per line. Applies to manual and automatic transfers.":
    "每行一个 HTTP(S) 地址前缀，例如 https://example.com/images/。匹配的图片在手动和自动转存时均会跳过。",
  "Attachment recovery copy saved:": "附件已保存至：",
  "Attachment recovery failed; temporary copy retained:": "附件保存失败，请检查临时文件位置：",
  Unavailable: "不可用",
  "No attachment matching the upload conditions was found.": "未找到可上传的附件。",
  "Upload service": "工具",
  "Executed command": "上传命令",
  "Test file path": "本地文件路径",
  "Upload test": "开始测试",
  "Enter the test file path": "请输入本地文件的完整路径。",
  "Upload successful": "上传成功",
  "Upload failed": "上传失败",
  "Attachment format to be uploaded": "上传文件类型",
  "Delete local files after successful upload": "上传后删除本地附件",
  "Upload succeeded but was not applied. Recovery receipt:":
    "上传成功，但未能更新笔记链接。上传地址已保存至：",
  "Upload succeeded but recovery receipt could not be saved. URL:":
    "上传成功，但未能更新笔记链接或保存上传记录。请保留以下地址：",
  "Auto upload": "自动上传",
  "Remote image transfer failed:": "外链图片转存失败：",
  Cancel: "取消",
  "Cancelling...": "正在取消…",
  Downloading: "下载图片",
  Uploading: "上传附件",
  Applying: "更新链接",
  "A maximum of {limit} remote image URLs can be transferred at once.":
    "每次最多转存 {limit} 个不同地址的外链图片。",
  "Failed:": "失败：",
  "Skipped:": "跳过：",
  "Not applied:": "链接未更新：",
  "Remote image URL prefixes to skip": "跳过的地址前缀",
  "Upload failed:": "上传失败：",
  "Unknown error": "未知错误",
  "Could not remove temporary files:": "无法清理临时文件：",
  "Attachment saved, but its link could not be inserted:": "附件已保存，但未能插入链接：",
  "Could not save the attachment to the vault:": "无法将附件保存到笔记库：",
};
