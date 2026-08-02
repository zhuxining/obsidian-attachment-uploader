import {
  type Editor,
  type FileSystemAdapter,
  type MarkdownFileInfo,
  type MarkdownView,
  Notice,
  Plugin,
  type TAbstractFile,
  TFile,
} from "obsidian";

import { AttachmentMatcher } from "./attachmentMatcher";
import { t } from "./lang/helpers";
import { UploadService } from "./services/UploadService";
import { DEFAULT_SETTINGS, type PluginSettings, SettingTab } from "./settingsTab";

export default class AttachmentUploader extends Plugin {
  declare settings: PluginSettings;
  private _attachmentMatcher?: AttachmentMatcher;
  private _uploadService?: UploadService;

  /**
   * 懒加载附件匹配器
   */
  get attachmentMatcher(): AttachmentMatcher {
    if (!this._attachmentMatcher) {
      this._attachmentMatcher = new AttachmentMatcher({ vault: this.app.vault });
    }
    return this._attachmentMatcher;
  }

  /**
   * 懒加载上传服务
   */
  get uploadService(): UploadService {
    if (!this._uploadService) {
      this._uploadService = new UploadService(
        this.settings.uploadCommand,
        this.settings.isDeleteSourceFile,
        this.settings.uploadFileFormat,
      );
    }
    return this._uploadService;
  }

  /**
   * 上传文件（委托给 UploadService，供设置页「上传测试」调用）
   */
  uploadServe(path: string): ReturnType<UploadService["uploadServe"]> {
    return this.uploadService.uploadServe(path);
  }

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

    // 注册粘贴上传事件
    this.registerEvent(
      this.app.workspace.on("editor-paste", async (evt, editor, info) => {
        await this.handlePasteUpload(evt, editor, info);
      }),
    );

    // 注册拖拽上传事件
    this.registerEvent(
      this.app.workspace.on("editor-drop", async (evt, editor) => {
        await this.handleDragUpload(evt, editor);
      }),
    );

    // 注册保存时自动上传事件（延迟到布局就绪后）
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("modify", async (file) => {
          await this.handleAutoUploadOnSave(file);
        }),
      );
    });
  }

  /**
   * 初始化服务实例
   */
  /**
   * 上传编辑器中的附件
   * 获取当前编辑器中的附件，并逐个处理上传
   */
  private async uploadEditorAttachment() {
    const activeEditor = this.app.workspace.activeEditor;
    if (!activeEditor) return;

    const attachments = this.attachmentMatcher.getEditorAttachments(activeEditor);
    const uploadableAttachments = this.uploadService.filterUploadableAttachments(attachments);

    if (uploadableAttachments.length === 0) {
      new Notice(t("No local attachment matching the upload conditions was found."));
      return;
    }

    new Notice(
      `${uploadableAttachments.length} ${t("attachments that matched the upload conditions \n Start uploading and replacing...")}`,
    );

    for (const attachment of uploadableAttachments) {
      await this.uploadService.processAttachment(attachment, activeEditor, this.app);
    }
  }

  /**
   * 处理粘贴上传
   */
  private async handlePasteUpload(
    evt: ClipboardEvent,
    editor: Editor,
    _info: MarkdownView | MarkdownFileInfo,
  ) {
    const items = evt.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && this.uploadService.isUploadableFile(file.name)) {
          evt.preventDefault(); // 阻止默认粘贴行为
          await this.uploadAndInsert(file, editor);
          break;
        }
      }
    }
  }

  /**
   * 处理拖拽上传
   */
  private async handleDragUpload(evt: DragEvent, editor: Editor) {
    const files = evt.dataTransfer?.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      if (this.uploadService.isUploadableFile(file.name)) {
        evt.preventDefault(); // 阻止默认拖拽行为
        await this.uploadAndInsert(file, editor);
      }
    }
  }

  /**
   * 处理保存时自动上传
   */
  private async handleAutoUploadOnSave(file: TAbstractFile) {
    if (!(file instanceof TFile)) return;
    if (!this.uploadService.isUploadableFile(file.name)) return;
    if (!this.settings.autoUploadOnSave) return;

    // 检查文件是否在支持的格式中
    const ext = file.extension.toLowerCase();
    if (!this.settings.uploadFileFormat.has(`.${ext}`)) return;

    // 上传文件并替换链接
    const basePath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    const uploadResult = await this.uploadService.uploadServe(`${basePath}/${file.path}`);
    if (uploadResult.success && uploadResult.url) {
      // 在所有打开的编辑器中替换该文件的链接
      await this.uploadService.replaceLocalLinksInAllEditors(this.app, file, uploadResult.url);
      new Notice(`${t("Auto uploaded:")} ${file.name}`);
    }
  }

  /**
   * 保存临时文件并上传，成功后插入链接到编辑器
   * 粘贴与拖拽共用同一套上传+插入逻辑
   */
  private async uploadAndInsert(file: File, editor: Editor) {
    const tempPath = await this.saveTempFile(file);
    const uploadResult = await this.uploadService.uploadServe(tempPath);

    if (uploadResult.success && uploadResult.url) {
      this.uploadService.insertUploadedFile(editor, file.name, uploadResult.url);
    }
  }

  /**
   * 保存临时文件
   */
  private async saveTempFile(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const tempDir = require("node:os").tmpdir();
    const tempPath = require("node:path").join(tempDir, file.name);

    require("node:fs").writeFileSync(tempPath, buffer);
    return tempPath;
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
      this.settings.uploadFileFormat = new Set(
        (this.settings.uploadFileFormat as string).split(","),
      );
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
