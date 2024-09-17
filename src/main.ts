// biome-ignore lint/style/useNodejsImportProtocol: <explanation>
import { exec } from "child_process";
import {
	type App,
	type FileSystemAdapter,
	type MarkdownFileInfo,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";

// biome-ignore lint/style/useNodejsImportProtocol: <explanation>
import { join, parse } from "path";
// biome-ignore lint/style/useNodejsImportProtocol: <explanation>
import { promisify } from "util";

import { t } from "./lang/helpers";

interface Attachment {
	basename: string;
	alt: string;
	name: string;
	ext: string;
	source: string;
	existenceState: "network" | "local" | "missing";
	inVaultPath: string;
	inSystemPath: string;
}

interface uploadCommandDict {
	[service: string]: string;
}
const uploadCommandDict: uploadCommandDict = {
	uPic: "/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s",
	Picsee: "/Applications/Picsee.app/Contents/MacOS/Picsee -u %s",
	custom: "",
};

interface PluginSettings {
	uploadService: string;
	uploadCommand: string;
	testFilePath: string;
	uploadFileFormat: Set<string>;
	isDeleteSourceFile: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	uploadService: "uPic",
	uploadCommand: uploadCommandDict.uPic,
	uploadFileFormat: new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"]),
	testFilePath: "",
	isDeleteSourceFile: false,
};
export default class AttachmentUploader extends Plugin {
	settings!: PluginSettings;

	/**
	 * 插件加载时执行的方法
	 * 加载设置，添加功能按钮和命令，设置设置选项卡
	 */
	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("upload", t("Upload attachments"), this.uploadEditorAttachment.bind(this));

		this.addCommand({
			id: "upload-editor-attachments",
			name: "Upload editor attachments",
			editorCallback: () => this.uploadEditorAttachment(),
		});

		this.addSettingTab(new SettingTab(this.app, this));
	}

	/**
	 * 上传编辑器中的附件
	 * 获取当前编辑器中的附件，并逐个处理上传
	 */
	private async uploadEditorAttachment() {
		const activeEditor = this.app.workspace.activeEditor;
		if (!activeEditor) return;

		const attachments = this.getEditorAttachments(activeEditor);
		if (attachments.length === 0) {
			new Notice(t("No local attachment matching the upload conditions was found."));
			return;
		}

		new Notice(
			`${attachments.length} ${t("attachments that matched the upload conditions \n Start uploading replacement...")}`,
		);

		for (const attachment of attachments) {
			await this.processAttachment(attachment, activeEditor);
		}
	}

	/**
	 * 处理单个附件
	 * 上传附件，更新编辑器内容，显示处理结果
	 */
	private async processAttachment(attachment: Attachment, activeEditor: MarkdownFileInfo) {
		const sourceFile = this.app.vault.getAbstractFileByPath(attachment.inVaultPath);
		const uploadResult = await this.uploadServe(attachment.inSystemPath);

		if (uploadResult.success && uploadResult.url) {
			this.updateEditorContent(activeEditor, attachment, uploadResult.url);
			new Notice(
				`${t("Uploaded attachment:")}${attachment.inVaultPath}\n${t("Replace with:")}${uploadResult.url}`
			);

			if (this.settings.isDeleteSourceFile && sourceFile instanceof TFile) {
				await this.app.vault.delete(sourceFile);
				new Notice(`${t("Local attachment deleted")}: ${attachment.inVaultPath}`);
			}
		} else {
			new Notice(
				`${t("Upload failed:")}${attachment.inVaultPath}\n\n${t("Error message:")}\n${uploadResult.errorMessage}`
			);
		}
	}

	/**
	 * 更新编辑器内容
	 * 替换原有的附件链接为新的URL
	 */
	private updateEditorContent(editor: MarkdownFileInfo, attachment: Attachment, newUrl: string) {
		const content = editor.editor?.getValue() ?? "";

		// https://help.obsidian.md/Files+and+folders/Accepted+file+formats
		// Obsidian accepted image file formats
		const isImage = /\.(avif|bmp|gif|jpeg|jpg|png|svg|webp)$/i.test(attachment.ext);
		const updatedContent = content.replace(
			attachment.source,
			isImage ? `![${attachment.name}](${encodeURI(newUrl)})` : `[${attachment.name}](${encodeURI(newUrl)})`
		);
		editor.editor?.setValue(updatedContent);
	}


	/**
	 * 获取编辑器中所有的附件
	 * 解析编辑器内容，找出符合条件的附件，条件为符合markdown链接格式![]()
	 */
	private getEditorAttachments(markdownFile: MarkdownFileInfo): Attachment[] {
		const content = markdownFile.editor?.getValue() ?? "";
		const regex = /!\[(.*?)\]\((.*?)\)/g;
		const matches = content.match(regex);
		if (!matches) return [];

		const vaultSystemPath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
		return matches
			.map((match) => this.parseAttachment(match, vaultSystemPath))
			.filter(
				(attachment): attachment is Attachment =>
					attachment !== null &&
					this.settings.uploadFileFormat.has(attachment.ext.toLowerCase()) &&
					attachment.existenceState === "local",
			);
	}

	/**
	 * 解析单个附件
	 * 从匹配的字符串中提取附件信息
	 */
	private parseAttachment(match: string, vaultSystemPath: string): Attachment | null {
		const attSourcePath = match.match(/\((.*?)\)/)?.[1];
		const alt = match.match(/\[(.*?)\]/)?.[1];
		if (!attSourcePath) return null;

		const file = parse(normalizePath(decodeURI(attSourcePath)));

		const searchFile = this.app.vault.getFiles().find((f) => f.name.toLowerCase() === (file.name + file.ext).toLowerCase());

		return {
			source: match,
			alt: alt ?? file.name,
			basename: file.base,
			name: file.name,
			ext: file.ext,
			// TODO：原计划是想把非白名单域名的文件转存到自己的OSS上
			existenceState: attSourcePath.startsWith("http") ? "network" : searchFile ? "local" : "missing",
			inVaultPath: searchFile ? searchFile.path : normalizePath(attSourcePath),
			inSystemPath: searchFile
				? encodeURI(join(vaultSystemPath, searchFile.path))
				: encodeURI(normalizePath(attSourcePath)),
		};
	}

	/**
	 * 执行上传服务
	 * 使用设置的上传命令上传文件
	 */
	async uploadServe(path: string): Promise<{ success: boolean; url?: string; errorMessage?: string }> {
		const execPromise = promisify(exec);
		try {
			const { stdout } = await execPromise(this.settings.uploadCommand.replace("%s", path));
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
	 * 加载插件设置
	 */
	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = { ...DEFAULT_SETTINGS, ...loadedData };

		if (loadedData?.uploadService === "custom" && loadedData?.uploadCommand) {
			this.settings.uploadCommand = loadedData.uploadCommand;
		}
		if (typeof this.settings.uploadFileFormat === "string") {
			this.settings.uploadFileFormat = new Set((this.settings.uploadFileFormat as string).split(","));
		}
	}

	/**
	 * 保存插件设置
	 */
	async saveSettings() {
		await this.saveData({
			...this.settings,
			uploadFileFormat: Array.from(this.settings.uploadFileFormat).join(","),
		});
	}
}

class SettingTab extends PluginSettingTab {
	plugin: AttachmentUploader;

	constructor(app: App, plugin: AttachmentUploader) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 显示设置选项卡
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.addUploadCommandSettings(containerEl);
		this.addUploadRulesSettings(containerEl);
	}

	/**
	 * 设置上传命令
	 */
	private addUploadCommandSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: t("Upload command") });

		new Setting(containerEl).setName(t("Upload service")).addDropdown((dropdown) =>
			dropdown
				.addOptions({
					uPic: "uPic",
					Picsee: "Picsee",
					custom: "custom",
				})
				.setValue(this.plugin.settings.uploadService)
				.onChange(async (value) => {
					this.plugin.settings.uploadService = value;
					this.plugin.settings.uploadCommand = uploadCommandDict[value];
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		new Setting(containerEl)
			.setName(t("Executed command"))
			.setDesc(
				`${t(
					"The command is executed using the exec method of child_process. %s indicates the path of the file to be uploaded, reserve it. Extract the uploaded link from the shell output after execution,"
				)}\n'urlMatch = stdout.match(/s+(https?:/ / S +) /)'`,
			)
			.addTextArea((textArea) =>
				textArea
					.setValue(this.plugin.settings.uploadCommand)
					.onChange(async (value) => {
						this.plugin.settings.uploadCommand = value;
						await this.plugin.saveSettings();
					})
					.setDisabled(this.plugin.settings.uploadService !== "custom")
					.inputEl.setAttribute("rows", "5"),
			);

		this.addTestFilePathSetting(containerEl);
	}

	/**
	 * 根据配置的上传命令，测试本地文件是否能上传成功
	 */
	private addTestFilePathSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("Test file path"))
			.addText((text) =>
				text.onChange(async (value) => {
					this.plugin.settings.testFilePath = value;
					await this.plugin.saveSettings();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText(t("Upload test")).onClick(async () => {
					if (!this.plugin.settings.testFilePath) {
						new Notice(t("Enter the test file path"));
						return;
					}
					const uploadResult = await this.plugin.uploadServe(this.plugin.settings.testFilePath);
					new Notice(uploadResult.success ? t("Upload successful") : t("Upload failed") + uploadResult.errorMessage);
				}),
			);
	}

	/**
	 * 配置上传规则，哪些格式的文件可以被上传
	 */
	private addUploadRulesSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: t("Upload rules") });

		new Setting(containerEl)
			.setName(t("Attachment format to be uploaded"))
			.setDesc(
				t(
					"The file in the configuration format will be uploaded when the command is executed and the original address will be replaced with the network address. The format will be separated by commas.",
				),
			)
			.addTextArea((textArea) =>
				textArea
					.setValue(Array.from(this.plugin.settings.uploadFileFormat).join(", "))
					.onChange(async (value) => {
						const formats = value.split(/[,\s]+/)
							.map(format => format.trim().toLowerCase())
							.filter(Boolean)
							.map(format => format.startsWith('.') ? format : `.${format}`);
						this.plugin.settings.uploadFileFormat = new Set(formats);
						await this.plugin.saveSettings();
					})
					.inputEl.setAttribute("rows", "4"),
			);

		new Setting(containerEl).setName(t("Delete local files after successful upload")).addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.isDeleteSourceFile).onChange(async (value) => {
				this.plugin.settings.isDeleteSourceFile = value;
				await this.plugin.saveSettings();
			}),
		);
	}
}
