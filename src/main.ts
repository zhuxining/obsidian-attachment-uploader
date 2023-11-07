import { exec } from "child_process";
import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	FileSystemAdapter,
	normalizePath,
	MarkdownFileInfo,
} from "obsidian";

import { join, parse } from "path";
import { format, promisify } from "util";

interface Attachment {
	basename: string;
	alt: string;
	name: string;
	ext: string;
	source: string;
	existenceState: string; //"network" | "local" | "missing"
	inVaultPath: string;
	inSystemPath: string;
}
interface PluginSettings {
	uploadService: string;
	uploadCommand: string;
	testFilePath: string;
	uploadFileFormat: string;
	isDeleteSourceFile: boolean;
}
interface uploadCommandDict {
	[service: string]: string;
}
const uploadCommandDict: uploadCommandDict = {
	uPic: "/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s",
	Picsee: "/Applications/Picsee.app/Contents/MacOS/Picsee -u %s",
	custom: "",
};
const DEFAULT_SETTINGS: PluginSettings = {
	uploadService: "uPic",
	uploadCommand: uploadCommandDict.uPic,
	uploadFileFormat: ".png\n.jpg\n.jpeg\n.gif\n.webp\n.ico\n.svg\n.bmp",
	testFilePath: "",
	isDeleteSourceFile: false,
};

export default class AttachmentUploader extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();
		const ribbonIconEl = this.addRibbonIcon(
			"upload",
			"Upload Attachments",
			(evt: MouseEvent) => {
				this.uploadEditorAttachment();
			}
		);
		ribbonIconEl.addClass("ribbon-class");

		this.addCommand({
			id: "upload-editor-attachments",
			name: "Upload editor attachments",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.uploadEditorAttachment();
			},
		});

		this.addSettingTab(new SettingTab(this.app, this));
	}

	private uploadEditorAttachment() {
		const activeEditor = this.app.workspace.activeEditor;
		if (activeEditor) {
			const attachments = this.getEditorAttachments(activeEditor);
			new Notice(
				attachments.length > 0
					? `已找到${attachments.length}个符合上传条件的附件\n开始上传替换…`
					: "未找到符合上传条件本地附件\n"
			);
			attachments.forEach(async (attachment) => {
				const sourceFile = this.app.vault.getAbstractFileByPath(
					attachment.inVaultPath
				);
				console.log(attachment.inVaultPath);
				const uploadResult = await this.uploadServe(
					attachment.inSystemPath
				);
				if (uploadResult.success) {
					activeEditor?.editor?.setValue(
						activeEditor?.editor
							?.getValue()
							.replace(
								attachment.source,
								`![${attachment.alt}](${uploadResult.url})`
							)
					);
					if (this.settings.isDeleteSourceFile && sourceFile) {
						this.app.vault.delete(sourceFile);
					}
					new Notice(
						`已上传附件：${attachment.inVaultPath}\n替换地址为:${
							uploadResult.url
						}\n${
							this.settings.isDeleteSourceFile && sourceFile
								? `本地附件已删除`
								: ""
						}`
					);
				} else {
					new Notice(
						`上传失败：${attachment.inVaultPath}\n\n错误信息:\n${uploadResult.errorMessage}`
					);
				}
			});
		}
	}
	/** 匹配文章内的附件信息
	 * @param markdownFile  markdown 文件
	 */
	private getEditorAttachments(markdownFile: MarkdownFileInfo): Attachment[] {
		const attachments: Attachment[] = [];
		const regex = /!\[(.*?)\]\((.*?)\)/g;
		const matches = markdownFile?.editor?.getValue().match(regex);
		const vaultSystemPath = (
			markdownFile?.file?.vault.adapter as FileSystemAdapter
		).getBasePath();
		if (matches) {
			matches.forEach((match) => {
				const attSourcePath = match.match(/\((.*?)\)/)?.[1];
				const alt = match.match(/\[(.*?)\]/)?.[1];
				if (attSourcePath) {
					const file = parse(normalizePath(decodeURI(attSourcePath)));
					const searchFile = this.app.vault
						.getFiles()
						.find(
							(f) => f.name === file.name + file.ext.toLowerCase()
						);
					const attachment = {
						source: match,
						alt: alt ? alt : file.name,
						basename: file.base,
						name: file.name,
						ext: file.ext,
						existenceState: attSourcePath.startsWith("http")
							? "network"
							: searchFile
							? "local"
							: "missing",
						inVaultPath: searchFile
							? searchFile?.path
							: normalizePath(attSourcePath),
						inSystemPath: searchFile
							? encodeURI(join(vaultSystemPath, searchFile?.path))
							: encodeURI(normalizePath(attSourcePath)),
					};

					if (
						this.settings.uploadFileFormat
							.split("\n")
							.includes(attachment.ext.toLowerCase()) &&
						attachment.existenceState === "local"
					) {
						attachments.push(attachment);
					}
				}
			});
		}
		return attachments;
	}
	/** 上传命令执行后从shell输出中提取上传后的链接
	 * @param path  要上传的文件在系统内的路径
	 */
	async uploadServe(
		path: string
	): Promise<{ success: boolean; url?: string; errorMessage?: string }> {
		const execPromise = promisify(exec);
		console.log(this.settings.uploadCommand);
		const command = format(this.settings.uploadCommand, path);
		try {
			const { stdout } = await execPromise(command);
			const urlMatch = stdout.match(/\s+(https?:\/\/\S+)/);
			if (urlMatch) {
				return {
					success: true,
					url: urlMatch[1],
				};
			} else {
				return {
					success: false,
					errorMessage: stdout,
				};
			}
		} catch (err) {
			console.error(`err: ${err}`);
			new Notice(err.message);
			throw err;
		}
	}
	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {}
}

class SettingTab extends PluginSettingTab {
	plugin: AttachmentUploader;

	constructor(app: App, plugin: AttachmentUploader) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h1", { text: "上传命令" });
		new Setting(containerEl).setName("上传服务").addDropdown((dropdown) => {
			return dropdown
				.addOptions({
					uPic: "uPic",
					Picsee: "Picsee",
					custom: "custom",
				})
				.setValue(this.plugin.settings.uploadService)
				.onChange(async (value) => {
					this.plugin.settings.uploadService = value;
					this.plugin.settings.uploadCommand =
						uploadCommandDict[this.plugin.settings.uploadService];
					this.display();
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
			.setName("执行命令")
			.setDesc(
				"命令通过child_process的exec方法执行; %s为要上传文件的路径,请保留; 执行后从shell输出中提取上传后的链接,‘urlMatch = stdout.match(/s+(https?:/ / S +) /)’"
			)
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder("请输入")
					.setValue(
						uploadCommandDict[this.plugin.settings.uploadService]
					)
					.onChange(async (value) => {
						this.plugin.settings.uploadCommand = value;
						await this.plugin.saveSettings();
					})
					.setDisabled(
						this.plugin.settings.uploadService !== "custom"
					);

				textArea.inputEl.style.height = "80px";
			});

		new Setting(containerEl).setName("测试文件路径").addText((text) => {
			text.onChange(async (value) => {
				this.plugin.settings.testFilePath = value;
				await this.plugin.saveSettings();
			});
			new Setting(containerEl).addButton((btn) => {
				btn.setButtonText("上传测试").onClick(async () => {
					if (!this.plugin.settings.testFilePath) {
						new Notice("请填写测试文件路径");
						return;
					}
					const uploadResult = await this.plugin.uploadServe(
						this.plugin.settings.testFilePath
					);
					new Notice(
						uploadResult.success
							? "上传成功\n"
							: "上传失败\n" + uploadResult.errorMessage
					);
				});
			});
		});

		containerEl.createEl("h1", { text: "上传规则" });
		new Setting(containerEl)
			.setName("上传内容格式")
			.setDesc(
				"配置内格式的文件，会在执行命令时被上传并替换原地址，以回车分割"
			)
			.addTextArea((textArea) => {
				textArea
					.setValue(this.plugin.settings.uploadFileFormat)
					.onChange(async (value) => {
						this.plugin.settings.uploadFileFormat = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.style.height = "120px";
			});

		new Setting(containerEl)
			.setName("上传成功后删除本地文件")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.isDeleteSourceFile)
					.onChange(async (value) => {
						this.plugin.settings.isDeleteSourceFile = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
