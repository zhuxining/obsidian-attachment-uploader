import { exec } from "child_process";
import {
	App,
	Editor,
	MarkdownView,
	Modal,
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

interface PluginSettings {
	uploadService: string;
	uploadCommand: string;
	testFilePath: string;
	fileFormatWhitelist: string;
}
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
interface uploadCommandDict {
	[service: string]: string;
}
const uploadCommandDict: uploadCommandDict = {
	uPic: "/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s",
	custom: "your custom command here",
	imgur: "imgur uploader command",
};
const DEFAULT_SETTINGS: PluginSettings = {
	uploadService: "uPic",
	uploadCommand: "ddd",
	fileFormatWhitelist: ".png",
	testFilePath: "",
};

export default class AttachmentUpload extends Plugin {
	settings: PluginSettings;

	async onload() {
		console.log("d");
		await this.loadSettings();
		const ribbonIconEl = this.addRibbonIcon(
			"upload",
			"Upload Attachments",
			(evt: MouseEvent) => {
				this.uploadEditorAttachment();
				new Notice("替换完成");
			}
		);
		// Perform additional things with the ribbon
		ribbonIconEl.addClass("my-plugin-ribbon-class");

		this.addCommand({
			id: "sample-editor-command",
			name: "Sample editor command",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection(String(this.uploadEditorAttachment()));
				this.uploadEditorAttachment();
			},
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: "open-sample-modal-complex",
			name: "Open sample modal (complex)",
			checkCallback: (checking: boolean) => {
				this.uploadEditorAttachment();
				// Conditions to check
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	private uploadEditorAttachment() {
		const currentDate = new Date();
		console.log(String(currentDate));
		const activeEditor = this.app.workspace.activeEditor;
		if (activeEditor) {
			const attachments = this.getEditorAttachments(activeEditor);
			attachments.forEach(async (attachment) => {
				console.log(attachment.inSystemPath);
				if (attachment.existenceState === "missing") {
					return;
				}
				if (attachment.existenceState === "network") {
					return;
				}
				if (attachment.existenceState === "local") {
					console.log(attachment.inSystemPath);
					const uploadUrl = await this.uploadServe(
						attachment.inSystemPath
					);
					console.log(uploadUrl);
					activeEditor?.editor?.setValue(
						activeEditor?.editor
							?.getValue()
							.replace(
								attachment.source,
								`![${attachment.alt}](${uploadUrl})`
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
	async uploadServe(path: string): Promise<string> {
		const execPromise = promisify(exec);
		const command = format(this.settings.uploadCommand, path);
		try {
			const { stdout } = await execPromise(command);
			const urlMatch = stdout.match(/\s+(https?:\/\/\S+)/);
			return urlMatch ? urlMatch?.[1] : stdout;
		} catch (err) {
			console.error(`err: ${err}`);
			throw err;
		}
	}

	onunload() {}

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
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText("Woah!");
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: AttachmentUpload;

	constructor(app: App, plugin: AttachmentUpload) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl("h1", { text: "上传命令" });
		new Setting(containerEl)
			.setName("上传服务")
			.setDesc("请选择")
			.addDropdown((dropdown) => {
				dropdown.addOptions({
					uPic: "uPic",
					custom: "custom",
				});
				dropdown.onChange(async (value) => {
					this.plugin.settings.uploadService = value;
					this.display();
					await this.plugin.saveSettings();
				});
				dropdown.setValue(this.plugin.settings.uploadService);
				// dropdown.selectEl.style.width = "100%";
			});

		new Setting(containerEl)
			.setName("执行命令")
			.setDesc(
				"命令通过child_process的exec方法执行; %s为要上传文件的路径,请保留; 执行后从shell输出中提取上传后的链接,‘urlMatch = stdout.match(/s+(https?:/ / S +) /)’"
			)
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder("Enter your secret")
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
				// textArea.inputEl.style.width = "100%";
			});
		new Setting(containerEl).setName("测试文件路径").addText((text) => {
			text.onChange(async (value) => {
				this.plugin.settings.testFilePath = value;
			});
			new Setting(containerEl).addButton((btn) => {
				btn.setButtonText("上传测试").onClick(async () => {
					// const uploadUrl = await this.plugin.uploadServe(
					// 	this.plugin.settings.testFilePath
					// );
					new Notice(this.plugin.settings.uploadCommand);
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
					.setValue(this.plugin.settings.fileFormatWhitelist)
					.onChange(async (value) => {
						this.plugin.settings.fileFormatWhitelist = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.style.height = "120px";
				// textArea.inputEl.style.width = "100%";
			});
	}
}
