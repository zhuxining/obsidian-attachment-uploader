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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export default class AttachmentUploader extends Plugin {
  declare settings: PluginSettings;
  private readonly autoUploadsInFlight = new Set<string>();
  private _attachmentMatcher?: AttachmentMatcher;

  /**
   * 懒加载附件匹配器
   */
  get attachmentMatcher(): AttachmentMatcher {
    if (!this._attachmentMatcher) {
      this._attachmentMatcher = new AttachmentMatcher({ vault: this.app.vault, metadataCache: this.app.metadataCache });
    }
    return this._attachmentMatcher;
  }

  /**
   * 懒加载上传服务
   */
  get uploadService(): UploadService {
    // Read the current settings on each operation; the previous cached
    // instance silently ignored upload command/format changes.
    return new UploadService(
      this.settings.uploadCommand,
      this.settings.isDeleteSourceFile,
      this.settings.uploadFileFormat,
    );
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

    if (this.autoUploadsInFlight.has(file.path)) return;
    // Only auto-upload files that a currently open note actually embeds.
    // Merely mentioning the filename in prose must never initiate an upload.
    const hasReference = this.app.workspace.getLeavesOfType("markdown").some((leaf) => {
      const view = leaf.view as MarkdownView;
      if (!view.file) return false;
      const cached = this.app.metadataCache.getFileCache(view.file);
      return cached?.embeds?.some((embed) =>
        this.app.metadataCache.getFirstLinkpathDest(embed.link, view.file!.path)?.path === file.path
      ) ?? false;
    });
    if (!hasReference) return;
    this.autoUploadsInFlight.add(file.path);
    try {
      const basePath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
      const result = await this.uploadService.uploadServe(join(basePath, file.path));
      if (result.success && result.url) {
        await this.uploadService.replaceLocalLinksInAllEditors(this.app, file, result.url);
        new Notice(`${t("Auto uploaded:")} ${file.name}`);
      }
    } finally {
      this.autoUploadsInFlight.delete(file.path);
    }
  }

  /**
   * 保存临时文件并上传，成功后插入链接到编辑器
   * 粘贴与拖拽共用同一套上传+插入逻辑
   */
  private async uploadAndInsert(file: File, editor: Editor) {
    const marker = `<!-- attachment-uploader:${crypto.randomUUID()} -->`;
    editor.replaceSelection(marker);
    const filename = basename(file.name.replace(/[\\/]/g, "_")) || "attachment.bin";
    let directory: string | null = null;
    try {
      directory = await mkdtemp(join(tmpdir(), "obsidian-attachment-uploader-"));
      const temporaryFile = join(directory, filename);
      await writeFile(temporaryFile, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
      const result = await this.uploadService.uploadServe(temporaryFile);
      if (result.success && result.url) {
        const didReplace = this.replaceMarker(editor, marker, this.uploadService.formatUploadedFile(filename, result.url));
        if (!didReplace) new Notice(`Uploaded ${filename}, but insertion was cancelled. URL: ${result.url}`, 10000);
      } else {
        await this.fallbackToVault(file, editor, marker);
        new Notice(`Cloud upload failed: ${result.errorMessage ?? "Unknown error"}`, 7000);
      }
    } catch (error) {
      await this.fallbackToVault(file, editor, marker);
      new Notice(`Cloud upload failed: ${String(error)}`, 7000);
    } finally {
      if (directory) {
        try { await rm(directory, { recursive: true, force: true }); }
        catch (error) { new Notice(`Could not clean up temporary upload: ${String(error)}`); }
      }
    }
  }

  private replaceMarker(editor: Editor, marker: string, replacement: string): boolean {
    const text = editor.getValue();
    const index = text.indexOf(marker);
    if (index < 0) return false;
    editor.replaceRange(replacement, editor.offsetToPos(index), editor.offsetToPos(index + marker.length));
    return true;
  }

  private async fallbackToVault(file: File, editor: Editor, marker: string): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    try {
      const path = await this.app.fileManager.getAvailablePathForAttachment(file.name, activeFile?.path);
      const saved = await this.app.vault.createBinary(path, await file.arrayBuffer());
      const link = this.app.fileManager.generateMarkdownLink(saved, activeFile?.path ?? "");
      const extension = saved.extension.toLowerCase();
      const embed = /^(png|jpe?g|gif|svg|webp|avif|bmp|mp3|wav|m4a|mp4|webm|mov|pdf)$/.test(extension);
      const markup = embed && !link.startsWith("!") ? `!${link}` : link;
      if (!this.replaceMarker(editor, marker, markup)) {
        new Notice(`Attachment saved locally but placeholder was removed: ${saved.path}`, 10000);
      }
    } catch (error) {
      // A pasted File is otherwise ephemeral. Keep an explicit recovery marker.
      new Notice(`Failed to preserve attachment locally: ${String(error)}`, 10000);
    }
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
