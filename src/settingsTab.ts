import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import { t } from "./lang/helpers";
import { uploadCommandDict } from "./services/UploadService";

export interface PluginSettings {
	uploadService: string;
	uploadCommand: string;
	testFilePath: string;
	uploadFileFormat: Set<string>;
	isDeleteSourceFile: boolean;
	autoUploadOnSave: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	uploadService: "uPic",
	uploadCommand: uploadCommandDict.uPic,
	uploadFileFormat: new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"]),
	testFilePath: "",
	isDeleteSourceFile: false,
	autoUploadOnSave: false,
};

export class SettingTab extends PluginSettingTab {
	plugin: any;

	constructor(app: App, plugin: any) {
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
					"The command is executed using the exec method of child_process. %s indicates the path of the file to be uploaded, reserve it. Extract the uploaded link from the shell output after execution reference README.md",
				)}`,
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
					new Notice(
						uploadResult.success
							? t("Upload successful")
							: t("Upload failed") + uploadResult.errorMessage,
					);
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
						const formats = value
							.split(/[,\s]+/)
							.map((format) => format.trim().toLowerCase())
							.filter(Boolean)
							.map((format) => (format.startsWith(".") ? format : `.${format}`));
						this.plugin.settings.uploadFileFormat = new Set(formats);
						await this.plugin.saveSettings();
					})
					.inputEl.setAttribute("rows", "4"),
			);

		new Setting(containerEl)
			.setName(t("Delete local files after successful upload"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.isDeleteSourceFile).onChange(async (value) => {
					this.plugin.settings.isDeleteSourceFile = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t("Auto upload"))
			.setDesc(
				t(
					"When enabled, files will be automatically uploaded and replaced when pasting or dragging",
				),
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoUploadOnSave).onChange(async (value) => {
					this.plugin.settings.autoUploadOnSave = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
