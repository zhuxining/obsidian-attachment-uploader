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

import { join, parse, resolve } from "path";
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
	fileFormatWhitelist: string;
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
	fileFormatWhitelist: ".png",
	testFilePath: "",
};

export default class AttachmentUpload extends Plugin {
	settings: PluginSettings;

	async onload() {
		// const currentDate = new Date();
		// console.log(String(currentDate));
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
			id: "upload-editor-attachment",
			name: "Upload editor attachment",
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
			const countExistenceState = attachments.reduce(
				(acc: Record<string, number>, attachment) => {
					if (!acc[attachment.existenceState]) {
						acc[attachment.existenceState] = 0;
					}
					acc[attachment.existenceState]++;
					return acc;
				},
				{}
			);
			new Notice(
				(countExistenceState["local"]
					? countExistenceState["local"]
					: 0) +
					"个本地附件\n" +
					(countExistenceState["network"]
						? countExistenceState["network"]
						: 0) +
					"个网络附件\n" +
					(countExistenceState["missing"]
						? countExistenceState["missing"]
						: 0) +
					"个未创建附件\n"
			);
			attachments.forEach(async (attachment) => {
				if (attachment.existenceState === "missing") {
					return;
				}
				if (attachment.existenceState === "network") {
					return;
				}
				if (attachment.existenceState === "local") {
					const uploadResult = await this.uploadServe(
						attachment.inSystemPath
					);
					activeEditor?.editor?.setValue(
						activeEditor?.editor
							?.getValue()
							.replace(
								attachment.source,
								`![${attachment.alt}](${uploadResult.url})`
							)
					);
				}
			});
		}
	}
	/** 匹配文章内的附件信息
	 * @param markdownFile 当 markdown 文件
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
					// TODO 改用getAbstractFileByPath方法
					console.log(file.base);
					console.log(attSourcePath);
					const searchFile = this.app.vault.getAbstractFileByPath(
						normalizePath(decodeURI(attSourcePath))
					);
					console.log(searchFile?.name);
					// .getFiles()
					// .find(
					// 	(f) => f.name === file.name + file.ext.toLowerCase()
					// );
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
							? encodeURI(searchFile?.path)
							: encodeURI(resolve(attSourcePath)),
						inSystemPath: searchFile
							? encodeURI(join(vaultSystemPath, searchFile?.path))
							: encodeURI(resolve(attSourcePath)),
					};
					attachments.push(attachment);
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
	plugin: AttachmentUpload;

	constructor(app: App, plugin: AttachmentUpload) {
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
					this.display();
					await this.plugin.saveSettings();
				});

			// dropdown.selectEl.style.width = "100%";
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
			.setDesc("配置内的文件格式，会在执行命令时被上传并替换原地址")
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder("Enter your secret")
					.onChange(async (value) => {
						this.plugin.settings.fileFormatWhitelist = value;
						await this.plugin.saveSettings();
					})
					.setValue(this.plugin.settings.fileFormatWhitelist);
				textArea.inputEl.style.height = "120px";
			});
	}
}
