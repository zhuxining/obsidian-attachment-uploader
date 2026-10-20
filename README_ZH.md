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
- 支持把 Markdown 引用的外链 HTTP(S) 图片转存到当前图床：整篇、选区，或在编辑器右键转存单张图片
- 可选 Markdown 粘贴策略（关闭 / 询问 / 自动），插入的文本保持原样
- 默认跳过已使用当前图床前缀的链接；单张图片可强制重新上传
- macOS 下只读取 uPic 当前默认图床的公开 URL 前缀；Picsee 或自定义命令可手动填写前缀，也可采用上次成功上传 URL 推导的建议前缀

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
   - **外链图片粘贴策略**：关闭时保持 Obsidian 原有粘贴行为；询问时先插入文本，再提示本次粘贴的图片是否转存；自动时立即转存本次粘贴范围
   - **自动识别当前图床**：仅支持 macOS 下的 uPic；只读取默认图床的公开 URL 前缀，不读取或显示配置中的密钥
   - **需要跳过的外链图片 URL 前缀**：每行一个 HTTP(S) 前缀。匹配要求协议、精确主机、有效端口和路径目录一致；`raw.githubusercontent.com` 等共享主机必须包含账号/仓库路径
   - **填入建议前缀**：根据最近一次成功上传的 URL 推导建议值，需由你确认后才会保存
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
3. 使用 `Transfer remote images in current note` 转存整篇外链图片，使用 `Transfer remote images in selection` 转存选区；在编辑器中右键图片可选择「转存此图片」或「强制重新上传此图片」
4. 粘贴 Markdown 文本时按外链图片粘贴策略处理。询问模式会先插入文本，再由通知提供仅针对本次粘贴范围的转存操作

外链转存限制：单次最多 100 个不同 URL，同时下载 3 张，单图 20 MiB，单批累计 200 MiB，单张下载 30 秒，最多重定向 3 次。默认拒绝 localhost、私网、链路本地、组播和文档示例地址。下载或上传失败会保留原链接，不会为外链图片创建 Vault 本地附件。不使用密钥、Cookie 或浏览器登录凭据。

重复执行规则：单批次相同 URL 只下载上传一次；不同笔记独立转存，所有外链转存的上传命令串行执行。重复点击同一操作不会重复启动。上传期间只追踪原引用：引用被删除、修改、编辑器切换或无法确认身份时停止替换，并为已成功上传的 URL 保存恢复回执。

切换插件的上传服务/命令，或检测到 uPic 当前图床变化时，会清空会话上传记录和样本建议；旧任务不能回写新记录，手动前缀配置保留。在 Picsee 或自定义工具内部切换图床后，请在设置中点击「清除会话记录」。已运行的上传仍可完成；取消等待中的上传不会启动命令。

## 感谢

- 参考[typora](https://typora.io/)图片上传
