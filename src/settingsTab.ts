import { type App, type Plugin, Notice, PluginSettingTab, Setting } from "obsidian";

import { t } from "./lang/helpers";
import { uploadCommandDict } from "./services/presets";
import type { UploadTargetDetection, UploadTargetReason } from "./services/uploadTargetResolver";
import {
  isRemoteImagePastePolicy,
  isUploadServiceName,
  parseUploadFormats,
  remoteImageRuleScopeKey,
  type PluginSettings,
} from "./settings";

interface PluginLike {
  settings: PluginSettings;
  saveSettings: () => Promise<void>;
  uploadServe: (path: string) => Promise<{ success: boolean; url?: string; errorMessage?: string }>;
  detectRemoteImageHost: () => Promise<UploadTargetDetection>;
  clearRemoteImageDetection: () => Promise<void>;
  clearRemoteImageSession: () => void;
  suggestRemoteImagePrefix: () => string | null;
}

const DETECTION_REASONS: Record<UploadTargetReason, Parameters<typeof t>[0]> = {
  "not-macos": "Automatic detection is only available on macOS.",
  "not-upic": "The upload service is not uPic.",
  "app-missing": "The uPic application could not be located.",
  "unsupported-version": "This uPic version is not supported for automatic detection.",
  "preferences-unavailable": "uPic preferences could not be read.",
  "no-default-host": "No default uPic host is configured.",
  "no-public-domain": "The default uPic host has no public domain.",
  "invalid-structure": "The uPic configuration structure is not supported.",
  "shared-host-too-broad": "The detected domain is too broad for a shared host.",
};

export class SettingTab extends PluginSettingTab {
  plugin: PluginLike;
  private detectionReason: UploadTargetReason | null = null;
  private detectionScopeKey: string | null = null;
  private manualPrefixInput: HTMLTextAreaElement | null = null;

  constructor(app: App, plugin: Plugin & PluginLike) {
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
    this.addRemoteImageSettings(containerEl);
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
          if (!isUploadServiceName(value)) return;
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
        text.setValue(this.plugin.settings.testFilePath).onChange(async (value) => {
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
            this.plugin.settings.uploadFileFormat = parseUploadFormats(value);
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

  private detectionReasonText(reason: UploadTargetReason | null): string {
    return reason ? t(DETECTION_REASONS[reason]) : "";
  }

  /**
   * Prefix rules and the paste policy are isolated by upload service and
   * command digest, so switching commands never silently reuses stale rules.
   */
  private addRemoteImageSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: t("Remote images") });
    const { settings } = this.plugin;
    const scopeKey = remoteImageRuleScopeKey(settings.uploadService, settings.uploadCommand);
    if (this.detectionScopeKey !== scopeKey) {
      this.detectionScopeKey = scopeKey;
      this.detectionReason = null;
    }

    new Setting(containerEl)
      .setName(t("Remote image paste policy"))
      .setDesc(
        t("Choose whether pasted Markdown text with remote images is transferred automatically."),
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ off: t("Off"), ask: t("Ask"), auto: t("Auto") })
          .setValue(settings.remoteImagePastePolicy)
          .onChange(async (value) => {
            if (!isRemoteImagePastePolicy(value)) return;
            settings.remoteImagePastePolicy = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("Automatically detect the current image host"))
      .setDesc(
        t(
          "Only the current default uPic host's public URL prefix is read. Configuration secrets are never read or shown.",
        ),
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.remoteImageAutoDetectHost).onChange(async (value) => {
          settings.remoteImageAutoDetectHost = value;
          await this.plugin.saveSettings();
        }),
      );

    const stored = settings.remoteImageAutoHostRules[scopeKey];
    const detectionDescription = [
      stored
        ? `${t("Detected host prefixes")}: ${stored.prefixes.join(", ")}`
        : t("No automatic detection result is stored."),
      this.detectionReason
        ? `${t("Automatic host detection failed:")} ${this.detectionReasonText(this.detectionReason)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    new Setting(containerEl)
      .setName(t("Detect current host"))
      .setDesc(detectionDescription)
      .addButton((button) =>
        button
          .setButtonText(t("Detect current host"))
          .setCta()
          .onClick(async () => {
            try {
              const result = await this.plugin.detectRemoteImageHost();
              this.detectionReason = result.reason;
              if (result.status === "detected") {
                new Notice(`${t("Detected host prefixes")}: ${result.prefixes.join(", ")}`);
              } else {
                new Notice(
                  `${t("Automatic host detection failed:")} ${this.detectionReasonText(result.reason)}`,
                );
              }
            } catch (error) {
              new Notice(`${t("Automatic host detection failed:")} ${String(error)}`);
            }
            this.display();
          }),
      )
      .addButton((button) =>
        button.setButtonText(t("Clear detection")).onClick(async () => {
          try {
            await this.plugin.clearRemoteImageDetection();
            this.detectionReason = null;
          } catch (error) {
            new Notice(String(error));
          }
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName(t("Session upload records"))
      .setDesc(
        t(
          "After switching hosts inside Picsee or a custom uploader, clear remembered URLs. Manual prefixes are kept.",
        ),
      )
      .addButton((button) =>
        button.setButtonText(t("Clear session records")).onClick(() => {
          this.plugin.clearRemoteImageSession();
          new Notice(t("Session upload records cleared."));
        }),
      );

    const manualSetting = new Setting(containerEl)
      .setName(t("Remote image URL prefixes to skip"))
      .setDesc(
        t(
          "One HTTP(S) URL prefix per line. Matching compares protocol, host, port and path directory.",
        ),
      );
    manualSetting.addTextArea((textArea) => {
      textArea
        .setValue((settings.remoteImageHostRules[scopeKey] ?? []).join("\n"))
        .onChange(async (value) => {
          settings.remoteImageHostRules[scopeKey] = value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        });
      textArea.inputEl.setAttribute("rows", "4");
      this.manualPrefixInput = textArea.inputEl;
    });
    manualSetting.addButton((button) =>
      button.setButtonText(t("Insert suggested prefix")).onClick(async () => {
        const suggestion = this.plugin.suggestRemoteImagePrefix();
        if (!suggestion) {
          new Notice(t("No successful upload URL is available for a suggestion."));
          return;
        }
        const input = this.manualPrefixInput;
        if (!input) return;
        const prefixes = input.value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (!prefixes.includes(suggestion)) prefixes.push(suggestion);
        input.value = prefixes.join("\n");
        settings.remoteImageHostRules[scopeKey] = prefixes;
        await this.plugin.saveSettings();
      }),
    );
  }
}
