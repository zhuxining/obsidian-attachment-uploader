# 兼容性

需要 Obsidian 桌面版 **1.14.4 或更高版本**。上传依赖本地可执行程序，不支持移动端。

# obsidian-attachment-uploader

这个 Obsidian 插件可以帮助你上传本地附件到云存储，支持自定义上传命令和需要上传的附件格式。

## 功能

- 支持自定义上传命令
  - 内置[uPic](https://github.com/gee1k/uPic)上传命令`/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s`
  - 内置[Picsee](https://picsee.chitaner.com/blog/Picsee_imageClound_command.html)上传命令`"/Applications/Picsee.app/Contents/MacOS/Picsee -u %s"`
- 自定义需要上传的附件格式
- 支持标准 Markdown 图片和 Wiki 嵌入，排除代码、注释和原始 HTML 区域
- 可选上传后删除原附件，默认关闭；遵循 Obsidian 回收站设置，有引用或检查不确定时保留
- 从 Obsidian 程序外粘贴或拖入文件时自动上传，上传失败则回退为本地附件
- 本地回退也失败，或云端上传成功但链接未能插入时，通知会显示恢复位置或 URL
- 「自动上传」开关仅控制现有本地附件修改时触发的上传

## 插件安装

1. 在 Obsidian 中，打开插件管理器
2. 搜索 "obsidian-attachment-uploader"
3. 点击 "安装",安装后启用并配置

## 使用配置

1. 安装带命令行接口的图床工具，或准备自定义上传程序
2. Obsidian attachment uploader 插件配置
   - **上传命令**：必须包含且仅包含一个独立的 `%s` 参数，用于传入附件本地路径。不支持直接使用 Shell 管道或变量展开；如有需要，可调用可信的可执行包装脚本。内置 uPic 和 Picsee 命令无需脚本。
   - **需要上传的附件格式**：配置需要上传的附件格式，以逗号或换行分隔
   - **上传后是否要删除原附件**：可选在附件链接成功替换后删除原附件
   - **自动上传**：现有本地附件修改时自动上传；粘贴和拖入上传独立于此开关
3. 自定义命令示例
   - uPic 命令：`/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s`
   - stdout 须输出唯一的 HTTP(S) 目标 URL，可带 `Output URL:` 标签，多个不同结果会被拒绝。
   - 输出示例：
     ```text
     Uploading ...
     Uploading 1/1
     Output URL:
     https://example.com/image.png
     ```

## 插件使用

1. 在 Obsidian 中打开包含附件的笔记
2. `command+p`呼出面板输入`Upload editor attachments`，或使用`Ribbon`按钮

## 感谢

- 参考[typora](https://typora.io/)图片上传
