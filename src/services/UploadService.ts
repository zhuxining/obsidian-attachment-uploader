/** biome-ignore-all lint/style/useNodejsImportProtocol: <obsidian limit> */
import { exec } from "child_process";
import { type Editor, type MarkdownView, Notice, TFile } from "obsidian";
import { promisify } from "util";
import type { Attachment } from "../attachmentMatcher";
import { t } from "../lang/helpers";

const execPromise = promisify(exec);

export interface UploadCommandDict {
	[service: string]: string;
}

export const uploadCommandDict: UploadCommandDict = {
	uPic: "/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s",
	Picsee: "/Applications/Picsee.app/Contents/MacOS/Picsee -u %s",
	custom: "",
};

export class UploadService {
	private uploadCommand: string;
	private isDeleteSourceFile: boolean;
	private uploadFileFormat: Set<string>;

	constructor(uploadCommand: string, isDeleteSourceFile: boolean, uploadFileFormat: Set<string>) {
		this.uploadCommand = uploadCommand;
		this.isDeleteSourceFile = isDeleteSourceFile;
		this.uploadFileFormat = uploadFileFormat;
	}

	/**
	 * 检查附件是否符合上传条件
	 */
	private isValidAttachment(attachment: Attachment): boolean {
		return (
			this.uploadFileFormat.has(attachment.ext.toLowerCase()) &&
			attachment.existenceState === "local"
		);
	}

	/**
	 * 检查文件是否可上传
	 */
	isUploadableFile(filename: string): boolean {
		const ext = filename.split(".").pop()?.toLowerCase() || "";
		return this.uploadFileFormat.has(`.${ext}`);
	}

	/**
	 * 过滤符合上传条件的附件列表
	 */
	filterUploadableAttachments(attachments: Attachment[]): Attachment[] {
		return attachments.filter((attachment) => this.isValidAttachment(attachment));
	}

	/**
	 * 执行上传服务
	 * 使用设置的上传命令上传文件
	 */
	async uploadServe(
		path: string,
	): Promise<{ success: boolean; url?: string; errorMessage?: string }> {
		try {
			// 确保路径被正确引用，防止空格问题
			const escapedPath = `"${path.replace(/"/g, '\\"')}"`;
			const { stdout } = await execPromise(this.uploadCommand.replace("%s", escapedPath));
			const urlMatch = stdout.match(/\s+(https?:\/\/\S+)/);
			return urlMatch
				? { success: true, url: decodeURIComponent(urlMatch[1]) }
				: { success: false, errorMessage: stdout };
		} catch (err) {
			console.error(`Upload error: ${err}`);
			return { success: false, errorMessage: (err as Error).message };
		}
	}

	/**
	 * 处理单个附件
	 * 上传附件，更新编辑器内容，显示处理结果
	 */
	async processAttachment(
		attachment: Attachment,
		activeEditor: { editor?: { getValue: () => string; setValue: (content: string) => void } },
		app: {
			vault: {
				getAbstractFileByPath: (path: string) => any;
				delete: (file: TFile) => Promise<void>;
			};
		},
	): Promise<void> {
		const sourceFile = app.vault.getAbstractFileByPath(attachment.inVaultPath);
		const uploadResult = await this.uploadServe(attachment.inSystemPath);

		if (uploadResult.success && uploadResult.url) {
			this.updateEditorContent(activeEditor, attachment, uploadResult.url);
			new Notice(
				`${t("Uploaded attachment:")}${attachment.inVaultPath}\n${t("Replace with:")}${uploadResult.url}`,
			);

			if (this.isDeleteSourceFile && sourceFile instanceof TFile) {
				await app.vault.delete(sourceFile);
				new Notice(`${t("Local attachment deleted")}: ${attachment.inVaultPath}`);
			}
		} else {
			new Notice(
				`${t("Upload failed:")}${attachment.inVaultPath}\n\n${t("Error message:")}\n${uploadResult.errorMessage}`,
			);
		}
	}

	/**
	 * 更新编辑器内容
	 * 替换原有的附件链接为新的URL
	 */
	private updateEditorContent(
		editor: { editor?: { getValue: () => string; setValue: (content: string) => void } },
		attachment: Attachment,
		newUrl: string,
	) {
		const content = editor.editor?.getValue() ?? "";

		// Obsidian accepted image file formats
		const isImage = /\.(avif|bmp|gif|jpeg|jpg|png|svg|webp)$/i.test(attachment.ext);

		// 确保正确处理包含空格的文件名
		const encodedUrl = encodeURI(newUrl).replace(/%20/g, "%20");
		const updatedContent = content.replace(
			attachment.source,
			isImage ? `![${attachment.name}](${encodedUrl})` : `[${attachment.name}](${encodedUrl})`,
		);
		editor.editor?.setValue(updatedContent);
	}

	/**
	 * 插入上传后的文件链接
	 */
	insertUploadedFile(editor: Editor, filename: string, url: string) {
		const isImage = /\.(avif|bmp|gif|jpeg|jpg|png|svg|webp)$/i.test(filename);
		const encodedUrl = encodeURI(url).replace(/%20/g, "%20");
		const markdown = isImage ? `![${filename}](${encodedUrl})` : `[${filename}](${encodedUrl})`;

		// 在当前光标位置插入
		const cursor = editor.getCursor();
		editor.replaceRange(markdown, cursor);
	}

	/**
	 * 在所有打开的编辑器中替换本地文件链接
	 */
	async replaceLocalLinksInAllEditors(app: any, file: TFile, newUrl: string) {
		const leaves = app.workspace.getLeavesOfType("markdown");

		for (const leaf of leaves) {
			const view = leaf.view;
			if (view && "editor" in view) {
				const markdownView = view as MarkdownView;
				const editor = markdownView.editor;
				if (editor) {
					const content = editor.getValue();

					// 创建匹配本地文件链接的正则表达式
					const fileNamePattern = file.name.replace(/([.*+?^=!:${}()[\]/\\])/g, "\\$1");
					const localLinkRegex = new RegExp(`![([^]]*)](${fileNamePattern})`, "g");

					// 替换所有匹配的链接
					const newContent = content.replace(localLinkRegex, (_match: string, altText: string) => {
						const isImage = /\.(avif|bmp|gif|jpeg|jpg|png|svg|webp)$/i.test(file.name);
						const encodedUrl = encodeURI(newUrl).replace(/%20/g, "%20");
						return isImage
							? `![${altText || file.name}](${encodedUrl})`
							: `[${altText || file.name}](${encodedUrl})`;
					});

					// 如果内容有变化，更新编辑器
					if (newContent !== content) {
						editor.setValue(newContent);
					}
				}
			}
		}
	}
}
