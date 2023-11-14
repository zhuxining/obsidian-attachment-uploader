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
		// 侧栏上传按钮
		this.addRibbonIcon(
			"upload",
			"Upload attachments",
			(evt: MouseEvent) => {
				this.uploadEditorAttachment();
			}
		);

		this.addCommand({
			id: "upload-editor-attachments",
			name: "Upload editor attachments",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.uploadEditorAttachment();
			},
		});

		this.addSettingTab(new SettingTab(this.app, this));
	}
	/**
	 * 上传编辑器内符合条件的附件
	 */
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
				// 获取附件在vault中的路径，配置需要删除时传入文件删除文件
				const sourceFile = this.app.vault.getAbstractFileByPath(
					attachment.inVaultPath
				);
				// 调用上传服务进行上传
				const uploadResult = await this.uploadServe(
					attachment.inSystemPath
				);
				if (uploadResult.success) {
					// 更新编辑器中的内容，将源文件地址替换为上传后附件的网络地址
					activeEditor?.editor?.setValue(
						activeEditor?.editor
							?.getValue()
							.replace(
								attachment.source,
								`![${attachment.alt}](${uploadResult.url})`
							)
					);
					// 如果设置为删除源文件且源文件存在，则删除源文件
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
	/**
	 * 获取编辑器中的附件信息
	 *
	 * @param markdownFile - Markdown文件信息对象
	 * @returns 附件数组
	 */
	private getEditorAttachments(markdownFile: MarkdownFileInfo): Attachment[] {
		const attachments: Attachment[] = [];
		const regex = /!\[(.*?)\]\((.*?)\)/g; // 用于匹配Markdown格式的图片链接的正则表达式
		const matches = markdownFile?.editor?.getValue().match(regex); // 从编辑器中获取Markdown文件的内容，并使用正则表达式匹配图片链接
		// 获取文件所在的vault路径
		const vaultSystemPath = (
			markdownFile?.file?.vault.adapter as FileSystemAdapter
		).getBasePath();

		if (matches) {
			matches.forEach((match) => {
				const attSourcePath = match.match(/\((.*?)\)/)?.[1]; // 从匹配结果中提取图片链接的路径部分
				const alt = match.match(/\[(.*?)\]/)?.[1]; // 从匹配结果中提取图片的alt文本

				if (attSourcePath) {
					// 将图片链接路径进行解码、规范化和解析，得到文件的信息
					const file = parse(normalizePath(decodeURI(attSourcePath)));
					// 在Vault中查找与该文件名称和扩展名匹配的文件
					const searchFile = this.app.vault
						.getFiles()
						.find(
							(f) => f.name === file.name + file.ext.toLowerCase()
						);

					const attachment = {
						source: match,
						alt: alt ? alt : file.name, // 如果有指定alt文本，则使用指定的alt文本，否则使用文件名称作为alt文本
						basename: file.base,
						name: file.name,
						ext: file.ext,
						existenceState: attSourcePath.startsWith("http")
							? "network" // 图片链接是网络地址
							: searchFile
							? "local" // 图片链接是本地地址
							: "missing", // 图片链接未找到
						inVaultPath: searchFile
							? searchFile?.path
							: normalizePath(attSourcePath), // 在Vault中找到对应的文件获取其Vault路径，否则为绝为原附件路径/图片网络链接
						inSystemPath: searchFile
							? encodeURI(join(vaultSystemPath, searchFile?.path)) // 如果找到对应的文件，则拼接出系统路径，否则为原附件路径/图片网络链接
							: encodeURI(normalizePath(attSourcePath)),
					};

					if (
						this.settings.uploadFileFormat
							.split("\n")
							.includes(attachment.ext.toLowerCase()) && // 检查文件扩展名是否在允许上传的文件格式中
						attachment.existenceState === "local" // 检查图片链接是否存在本地
					) {
						attachments.push(attachment); // 将符合条件的附件添加到附件数组中
					}
				}
			});
		}

		return attachments; // 返回附件数组
	}

	/** 上传命令执行后从shell输出中提取上传后的链接
	 *
	 * @param path  要上传的文件在系统内的路径
	 */
	async uploadServe(
		path: string
	): Promise<{ success: boolean; url?: string; errorMessage?: string }> {
		const execPromise = promisify(exec);

		// 构建shell命令
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
				textArea.inputEl.style.height = "150px";
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
