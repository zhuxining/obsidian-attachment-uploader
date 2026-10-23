import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, Plugin } from "obsidian";

import { t } from "./lang/helpers";
import { parseSettings, serializeSettings, type PluginSettings } from "./settings";
import { SettingTab } from "./settingsTab";
import { UploadWorkflow } from "./uploadWorkflow";

export default class AttachmentUploader extends Plugin {
  declare settings: PluginSettings;
  private workflow?: UploadWorkflow;

  async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    const workflow = new UploadWorkflow(this.app, this.settings);
    this.workflow = workflow;
    this.registerEditorExtension(
      ViewPlugin.define((view) => ({
        update(update: ViewUpdate) {
          workflow.updateEditor(update);
        },
        destroy() {
          const editor = view.state.field(editorInfoField, false)?.editor;
          if (editor) workflow.detachEditor(editor);
        },
      })),
    );
    this.register(() => workflow.dispose());
    this.addRibbonIcon("upload", t("Upload current note attachments"), () => {
      void workflow.uploadCurrentNote();
    });
    this.addCommand({
      id: "upload-editor-attachments",
      name: t("Upload current note attachments"),
      editorCallback: async () => await workflow.uploadCurrentNote(),
    });
    this.addSettingTab(new SettingTab(this.app, this));
    this.registerEvent(
      this.app.workspace.on("editor-paste", async (event, editor, info) => {
        await workflow.handlePaste(event, editor, info);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-drop", async (event, editor, info) => {
        await workflow.handleDrop(event, editor, info);
      }),
    );
  }

  async uploadServe(path: string) {
    if (!this.workflow) throw new Error("Attachment uploader has not loaded");
    return await this.workflow.uploadFile(path);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(serializeSettings(this.settings));
  }
}
