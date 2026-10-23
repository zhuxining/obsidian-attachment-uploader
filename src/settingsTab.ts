import {
  type App,
  Notice,
  PluginSettingTab,
  type Plugin,
  type Setting,
  type SettingDefinitionItem,
} from "obsidian";

import { t } from "./lang/helpers";
import {
  isUploadServiceName,
  parseUploadFormats,
  uploadCommandDict,
  type PluginSettings,
} from "./settings";

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

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: t("Upload tool"),
        items: [
          {
            name: t("Upload service"),
            control: {
              type: "dropdown",
              key: "uploadService",
              options: { uPic: "uPic", Picsee: "Picsee", custom: t("Custom") },
            },
          },
          {
            name: t("Executed command"),
            desc: t("Upload command instructions"),
            visible: () => this.plugin.settings.uploadService === "custom",
            control: { type: "textarea", key: "uploadCommand", rows: 5 },
          },
          {
            name: t("Test upload"),
            desc: t("Testing uploads the selected file to your configured host."),
            render: (setting) => this.renderTestUpload(setting),
          },
        ],
      },
      {
        type: "group",
        heading: t("Upload options"),
        items: [
          {
            name: t("Auto upload"),
            desc: t("Automatically upload attachments when pasting or dragging files."),
            control: { type: "toggle", key: "autoUpload" },
          },
          {
            name: t("Include remote images"),
            desc: t("Also transfer HTTP(S) images in pasted Markdown text."),
            control: {
              type: "toggle",
              key: "autoTransferRemoteImages",
              disabled: () => !this.plugin.settings.autoUpload,
            },
          },
          {
            name: t("Attachment format to be uploaded"),
            desc: t(
              "File extensions separated by commas or line breaks, e.g. .png, .jpg, .pdf. Used by manual uploads, pasted or dropped files, remote image transfers and batch migration; the test upload in settings is not filtered.",
            ),
            control: { type: "textarea", key: "uploadFileFormat", rows: 3 },
          },
          {
            name: t("Delete local files after successful upload"),
            desc: t(
              "Only delete vault source files after replacing links and checking remaining references.",
            ),
            control: { type: "toggle", key: "isDeleteSourceFile" },
          },
        ],
      },
      {
        type: "group",
        heading: t("Skip rules"),
        items: [
          {
            name: t("Remote image URL prefixes to skip"),
            desc: t("One HTTP(S) URL prefix per line. Applies to manual and automatic transfers."),
            control: { type: "textarea", key: "remoteImageSkipPrefixes", rows: 4 },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    switch (key) {
      case "uploadFileFormat":
        return Array.from(settings.uploadFileFormat).join(", ");
      case "remoteImageSkipPrefixes":
        return settings.remoteImageSkipPrefixes.join("\n");
      default:
        return (settings as unknown as Record<string, unknown>)[key];
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    switch (key) {
      case "uploadService":
        if (!isUploadServiceName(value)) return;
        settings.uploadService = value;
        settings.uploadCommand = uploadCommandDict[value];
        break;
      case "uploadCommand":
        settings.uploadCommand = String(value ?? "");
        break;
      case "uploadFileFormat":
        settings.uploadFileFormat = parseUploadFormats(String(value ?? ""));
        break;
      case "remoteImageSkipPrefixes":
        settings.remoteImageSkipPrefixes = String(value ?? "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        break;
      case "autoUpload":
        if (typeof value !== "boolean") return;
        settings.autoUpload = value;
        break;
      case "autoTransferRemoteImages":
        if (typeof value !== "boolean") return;
        settings.autoTransferRemoteImages = value;
        break;
      case "isDeleteSourceFile":
        if (typeof value !== "boolean") return;
        settings.isDeleteSourceFile = value;
        break;
      default:
        return;
    }
    await this.plugin.saveSettings();
    // Visibility and disabled predicates depend on these two values.
    if (key === "uploadService") this.update();
    else if (key === "autoUpload") this.refreshDomState();
  }

  private renderTestUpload(setting: Setting): void {
    let testFilePath = "";
    setting
      .addText((text) =>
        text.setPlaceholder(t("Test file path")).onChange((value) => {
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
}
