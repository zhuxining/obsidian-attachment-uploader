import { type App, type Plugin, Notice, PluginSettingTab, Setting } from "obsidian";

import { t } from "./lang/helpers";
import { uploadCommandDict } from "./settings";
import { isUploadServiceName, parseUploadFormats, type PluginSettings } from "./settings";

interface PluginLike {
  settings: PluginSettings;
  saveSettings: () => Promise<void>;
  uploadServe: (path: string) => Promise<{ success: boolean; url?: string; errorMessage?: string }>;
}

export class SettingTab extends PluginSettingTab {
  plugin: PluginLike;

  constructor(app: App, plugin: Plugin & PluginLike) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.addUploadCommandSettings(containerEl);
    this.addUploadRulesSettings(containerEl);
    this.addSkipRulesSettings(containerEl);
  }

  private addUploadCommandSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: t("Upload tool") });
    new Setting(containerEl).setName(t("Upload service")).addDropdown((dropdown) =>
      dropdown
        .addOptions({ uPic: "uPic", Picsee: "Picsee", custom: t("Custom") })
        .setValue(this.plugin.settings.uploadService)
        .onChange(async (value) => {
          if (!isUploadServiceName(value)) return;
          this.plugin.settings.uploadService = value;
          this.plugin.settings.uploadCommand = uploadCommandDict[value];
          await this.plugin.saveSettings();
          this.display();
        }),
    );

    if (this.plugin.settings.uploadService === "custom") {
      new Setting(containerEl)
        .setName(t("Executed command"))
        .setDesc(t("Upload command instructions"))
        .addTextArea((textArea) => {
          textArea.setValue(this.plugin.settings.uploadCommand).onChange(async (value) => {
            this.plugin.settings.uploadCommand = value;
            await this.plugin.saveSettings();
          });
          textArea.inputEl.setAttribute("rows", "5");
        });
    }

    const details = containerEl.createEl("details");
    details.createEl("summary", { text: t("Test upload") });
    let testFilePath = "";
    new Setting(details)
      .setName(t("Test file path"))
      .setDesc(t("Testing uploads the selected file to your configured host."))
      .addText((text) =>
        text.onChange((value) => {
          testFilePath = value.trim();
        }),
      )
      .addButton((button) =>
        button.setButtonText(t("Upload test")).onClick(async () => {
          if (!testFilePath) {
            new Notice(t("Enter the test file path"));
            return;
          }
          button.setDisabled(true);
          try {
            const result = await this.plugin.uploadServe(testFilePath);
            new Notice(
              result.success
                ? `${t("Upload successful")}
${result.url ?? ""}`
                : `${t("Upload failed:")} ${result.errorMessage ?? t("Unknown error")}`,
            );
          } catch (error) {
            new Notice(`${t("Upload failed:")} ${String(error)}`);
          } finally {
            button.setDisabled(false);
          }
        }),
      );
  }

  private addUploadRulesSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: t("Upload behavior") });
    const { settings } = this.plugin;
    const autoSetting = new Setting(containerEl);
    autoSetting
      .setName(t("Auto upload"))
      .setDesc(t("Automatically upload attachments when pasting or dragging files."))
      .addToggle((toggle) =>
        toggle.setValue(settings.autoUpload).onChange(async (value) => {
          settings.autoUpload = value;
          remoteSetting.setDisabled(!value);
          await this.plugin.saveSettings();
        }),
      );
    const remoteSetting = new Setting(containerEl)
      .setName(t("Include remote images"))
      .setDesc(t("Also transfer HTTP(S) images in pasted Markdown text."))
      .addToggle((toggle) =>
        toggle.setValue(settings.autoTransferRemoteImages).onChange(async (value) => {
          settings.autoTransferRemoteImages = value;
          await this.plugin.saveSettings();
        }),
      )
      .setDisabled(!settings.autoUpload);

    new Setting(containerEl)
      .setName(t("Attachment format to be uploaded"))
      .setDesc(
        t(
          "File extensions separated by commas or line breaks, e.g. .png, .jpg, .pdf. Used by manual uploads, pasted or dropped files, remote image transfers and batch migration; the test upload in settings is not filtered.",
        ),
      )
      .addTextArea((textArea) => {
        textArea
          .setValue(Array.from(settings.uploadFileFormat).join(", "))
          .onChange(async (value) => {
            settings.uploadFileFormat = parseUploadFormats(value);
            await this.plugin.saveSettings();
          });
        textArea.inputEl.setAttribute("rows", "3");
      });
    new Setting(containerEl)
      .setName(t("Delete local files after successful upload"))
      .setDesc(
        t(
          "Only delete vault source files after replacing links and checking remaining references.",
        ),
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.isDeleteSourceFile).onChange(async (value) => {
          settings.isDeleteSourceFile = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  private addSkipRulesSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: t("Skip rules") });
    new Setting(containerEl)
      .setName(t("Remote image URL prefixes to skip"))
      .setDesc(t("One HTTP(S) URL prefix per line. Applies to manual and automatic transfers."))
      .addTextArea((textArea) => {
        textArea
          .setValue(this.plugin.settings.remoteImageSkipPrefixes.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.remoteImageSkipPrefixes = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        textArea.inputEl.setAttribute("rows", "4");
      });
  }
}
