import { TAbstractFile } from "obsidian";
import { parse, Uri } from "path";

interface Attachment {
	name: string;
	path: string;
	source: string;
}
export class AttachmentMatch {


	getAttachments(markdown: string, filePath: TAbstractFile) {
		// 匹配两种语法
		const regex = /!\[\[.*\]\]|!\((.*?)(\[\])/g;
		const attachments: Attachment[] = [];
		const matches = markdown.match(regex);
		if (matches) {
			matches.forEach((match) => {
				// 提取路径
				let path = match.slice(3, -2);

				// 处理三种形式的路径
				if (path.startsWith("../")) {
					// 相对路径
					path = this.normalizePath(file.parent.path + "/" + path);
				} else if (!path.startsWith("/")) {
					// 短形式
					path = this.normalizePath(file.parent.path + "/" + path);
				} else {
					// 绝对路径
					path = this.normalizePath(path);
				}

				// 构造Attachment对象
				const attachment = {
					name: path.split("/").pop(),
					path,
					source: match,
				};

				attachments.push(attachment);
			});
		}

		return attachments;
	}

	// 规范化路径,兼容不同系统
	normalizePath(path: string) {
		return Uri.parse(path).toString();
	}}