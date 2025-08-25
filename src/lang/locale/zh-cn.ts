export default {
	"Upload attachments": "上传附件",
	"No local attachment matching the upload conditions was found.": "未找到符合上传条件本地附件",
	"attachments that matched the upload conditions \n Start uploading replacement...":
		"个符合上传条件的附件\n开始上传替换…",
	"Uploaded attachment:": "已上传附件:",
	"Replace with:": "替换为:",
	"Local attachment deleted": "本地附件已删除",
	"Upload failed:": "上传失败:",
	"Error message:": "错误信息:",
	"Upload command": "上传命令",
	"Upload service": "上传服务",
	"Executed command": "执行命令",
	"The command is executed using the exec method of child_process. %s indicates the path of the file to be uploaded, reserve it. Extract the uploaded link from the shell output after execution,":
		"命令通过child_process的exec方法执行; 自定义命令要求为[脚本+本地图片地址]能执行且执行成功后在shell中打印上传后的https网络地址,%s代替文件本地路径;如「/custom.script /one.png」执行后shell中输出「...https://domain/one.png...」,插件会通过正则提取[https://domain/one.png],正则匹配语法为",
	"Test file path": "测试文件路径",
	"Upload test": "上传测试",
	"Enter the test file path": "请输入测试上传文件路径",
	"Upload successful": "上传成功",
	"Upload failed": "上传失败",
	"Upload rules": "上传规则",
	"Attachment format to be uploaded": "需求上传附件的格式",
	"The file in the configuration format will be uploaded when the command is executed and the original address will be replaced with the network address. The format will be separated by commas.":
		"配置内格式的文件，会在执行命令时被上传并用网络地址替换原地址，格式以「英文逗号」分割",
	"Delete local files after successful upload": "上传成功后删除本地文件",
	"Auto uploaded:": "自动上传:",
	"Auto upload": "自动上传",
	"When enabled, files will be automatically uploaded and replaced when pasting or dragging":
		"开启后，粘贴、拖拽时会自动上传并替换文件",
};
