# obsidian-attachment-uploader

这个 Obsidian 插件可以帮助你上传本地附件到云存储,上传shell命令可以自定义,要上传附件的格式可自定义。

## 功能

* 支持自定义shell命令进行上传
  * 内置[uPic](https://github.com/gee1k/uPic)上传命令`/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s`
  * 内置[Picsee](https://picsee.chitaner.com/blog/Picsee_imageClound_command.html)上传命令`"/Applications/Picsee.app/Contents/MacOS/Picsee -u %s"`
* 自定义需要上传的附件格式
* 上传后是否要删除原附件

## 插件安装

1. 在 Obsidian 中，打开插件管理器
2. 搜索 "obsidian-attachment-uploader"
3. 点击 "安装",安装后启用并配置


## 使用配置

1.  安装图床工具（带shell上传命令）或自定义制作shell上传命令
2.  Obsidian attachment uploader插件配置
    -  上传命令：配置上传附件的 shell 命令
    -  需要上传的附件格式：配置需要上传的附件格式,以回车分隔
    -  上传后是否要删除原附件：配置上传后是否要删除原附件
3. 自定义命令示例
    - uPic在shell中的执行命令为`/Applications/uPic.app/Contents/MacOS/uPic -o url -u /local.png`
    - shell中输出为
        ```
        Uploading ...
        Uploading 1/1
        Output URL:
        https://r-w.oss-cn-shanghai.aliyuncs.com/uPic/Snipaste_2024-08-18_22-14-14.png?x-oss-process=image/auto-orient,1/quality,q_80/format,webp
        ```
    - 此插件用%s代替图片本地地址，通过`urlMatch = stdout.match(/s+(https?:/ / S +) /)`来提取命令执行后shell中输出的图片url
    - 因此使用uPic命令为`/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s`
    - 如果自己写脚本来上传图片,请在shell输出中打印上传后的图片网络地址

## 插件使用

1. 在 Obsidian 中打开包含附件的笔记
2. `command+p`呼出面板输入`Upload editor attachments`，或使用`Ribbon`按钮

## 感谢

* 参考[typora](https://typora.io/)图片上传


