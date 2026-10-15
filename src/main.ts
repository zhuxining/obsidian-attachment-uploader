import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

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
import { preserveUploadReceipt } from "./services/uploadReceipts";
import { UploadService, type UploadTasks } from "./services/uploadService";
import { parseSettings, serializeSettings, type PluginSettings } from "./settings";
import { SettingTab } from "./settingsTab";

export default class AttachmentUploader extends Plugin {
  declare settings: PluginSettings;
  private readonly autoUploadsInFlight = new Set<string>();
  private readonly uploadTasks: UploadTasks = new Map();
  private readonly manualUploadsInFlight = new Set<string>();
  private _attachmentMatcher?: AttachmentMatcher;

  /**
   * 懒加载附件匹配器
   */
  get attachmentMatcher(): AttachmentMatcher {
    if (!this._attachmentMatcher) {
      this._attachmentMatcher = new AttachmentMatcher({
        vault: this.app.vault,
        metadataCache: this.app.metadataCache,
      });
    }
    return this._attachmentMatcher;
  }

  get uploadService(): UploadService {
    // Read the current settings on each operation; the previous cached
    // instance silently ignored upload command/format changes.
    return new UploadService(
      this.settings.uploadCommand,
      this.settings.isDeleteSourceFile,
      this.settings.uploadFileFormat,
      this.uploadTasks,
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
      this.app.workspace.on("editor-drop", async (evt, editor, info) => {
        await this.handleDragUpload(evt, editor, info);
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
   * 上传编辑器中的附件
   * 获取当前编辑器中的附件，并逐个处理上传
   */
  private async uploadEditorAttachment() {
    const activeEditor = this.app.workspace.activeEditor;
    if (!activeEditor) return;
    const sourceFile = activeEditor.file;

    const attachments = this.attachmentMatcher.getEditorAttachments(activeEditor);
    const uploadableAttachments = Array.from(
      new Map(
        this.uploadService
          .filterUploadableAttachments(attachments)
          .map((attachment) => [attachment.inVaultPath, attachment]),
      ).values(),
    );

    if (uploadableAttachments.length === 0) {
      new Notice(t("No local attachment matching the upload conditions was found."));
      return;
    }

    new Notice(
      `${uploadableAttachments.length} ${t("attachments that matched the upload conditions \n Start uploading and replacing...")}`,
    );

    for (const attachment of uploadableAttachments) {
      if (activeEditor.file !== sourceFile) break;
      const key = JSON.stringify([activeEditor.file?.path, attachment.inVaultPath]);
      if (this.manualUploadsInFlight.has(key)) continue;
      this.manualUploadsInFlight.add(key);
      try {
        await this.uploadService.processAttachment(attachment, activeEditor, this.app);
      } finally {
        this.manualUploadsInFlight.delete(key);
      }
    }
  }

  /**
   * 处理粘贴上传
   */
  private async handlePasteUpload(
    evt: ClipboardEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ) {
    const items = evt.clipboardData?.items;
    if (!items) return;

    const files = Array.from(items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    await this.handleFileInsertion(evt, files, editor, info.file?.path ?? "");
  }

  /**
   * 处理拖拽上传
   */
  private async handleDragUpload(
    evt: DragEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ) {
    const files = evt.dataTransfer?.files;
    if (!files || files.length === 0) return;
    await this.handleFileInsertion(evt, Array.from(files), editor, info.file?.path ?? "");
  }

  private async handleFileInsertion(evt: Event, files: File[], editor: Editor, sourcePath: string) {
    if (evt.defaultPrevented) return;
    // A DOM event is handled as a whole. Mixed batches remain Obsidian's responsibility.
    if (!files.length || files.some((file) => !this.uploadService.isUploadableFile(file.name)))
      return;
    evt.preventDefault();
    const pending = files.map((file) => ({
      file,
      marker: `<!-- attachment-uploader:${crypto.randomUUID()} -->`,
    }));
    editor.replaceSelection(pending.map(({ marker }) => marker).join("\n"));
    for (const { file, marker } of pending) {
      await this.uploadAndInsert(file, editor, sourcePath, marker);
    }
  }

  /**
   * 处理保存时自动上传
   */
  private async handleAutoUploadOnSave(file: TAbstractFile) {
    if (!this.settings.autoUploadOnSave) return;
    if (!(file instanceof TFile)) return;
    if (!this.uploadService.isUploadableFile(file.name)) return;

    if (this.autoUploadsInFlight.has(file.path)) return;
    // Only auto-upload files that a currently open note actually embeds.
    // Merely mentioning the filename in prose must never initiate an upload.
    const hasReference = this.app.workspace.getLeavesOfType("markdown").some((leaf) => {
      if (leaf.isDeferred) return false;
      const view = leaf.view as MarkdownView;
      if (!view.file) return false;
      const cached = this.app.metadataCache.getFileCache(view.file);
      return (
        cached?.embeds?.some(
          (embed) =>
            this.app.metadataCache.getFirstLinkpathDest(embed.link, view.file!.path)?.path ===
            file.path,
        ) ?? false
      );
    });
    if (!hasReference) return;
    this.autoUploadsInFlight.add(file.path);
    try {
      const basePath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
      const result = await this.uploadService.uploadServe(join(basePath, file.path));
      if (result.success && result.url) {
        let replacements = 0;
        try {
          replacements = await this.uploadService.replaceLocalLinksInAllEditors(
            this.app,
            file,
            result.url,
          );
        } catch {
          // Some editors may have changed before another editor threw.
        }
        if (replacements > 0) new Notice(`${t("Auto uploaded:")} ${file.name}`);
        else await preserveUploadReceipt(result.url, join(basePath, file.path), file.name);
      }
    } finally {
      this.autoUploadsInFlight.delete(file.path);
    }
  }

  /**
   * 保存临时文件并上传，成功后插入链接到编辑器
   * 粘贴与拖拽共用同一套上传+插入逻辑
   */
  private async uploadAndInsert(
    file: File,
    editor: Editor,
    sourcePath: string,
    reservedMarker?: string,
  ) {
    const marker = reservedMarker ?? `<!-- attachment-uploader:${crypto.randomUUID()} -->`;
    if (!reservedMarker) editor.replaceSelection(marker);
    const filename = basename(file.name.replace(/[\\/]/g, "_")) || "attachment.bin";
    let directory: string | null = null;
    let safelyStored = false;
    try {
      directory = await mkdtemp(join(tmpdir(), "obsidian-attachment-uploader-"));
      const temporaryFile = join(directory, filename);
      await writeFile(temporaryFile, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
      const result = await this.uploadService.uploadServe(temporaryFile);
      if (result.success && result.url) {
        safelyStored = true;
        let didReplace = false;
        try {
          didReplace = await this.replaceSourceMarker(
            editor,
            marker,
            this.uploadService.formatUploadedFile(filename, result.url),
            sourcePath,
          );
        } catch {
          // A successful upload must not be reported as a failed cloud command.
        }
        if (!didReplace) await preserveUploadReceipt(result.url, sourcePath, filename);
      } else {
        safelyStored = await this.fallbackToVault(file, editor, marker, sourcePath);
        new Notice(`Cloud upload failed: ${result.errorMessage ?? "Unknown error"}`, 7000);
      }
    } catch (error) {
      safelyStored = await this.fallbackToVault(file, editor, marker, sourcePath);
      new Notice(`Cloud upload failed: ${String(error)}`, 7000);
    } finally {
      if (!safelyStored) {
        try {
          const recoveryRoot = join(homedir(), ".obsidian-attachment-uploader-recovery");
          await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
          const recoveryDirectory = await mkdtemp(join(recoveryRoot, "attachment-"));
          const recoveryPath = join(recoveryDirectory, filename);
          await writeFile(recoveryPath, Buffer.from(await file.arrayBuffer()), {
            flag: "wx",
            mode: 0o600,
          });
          safelyStored = true;
          new Notice(`${t("Attachment recovery copy saved:")} ${recoveryPath}`, 0);
        } catch (error) {
          new Notice(
            `${t("Attachment recovery failed; temporary copy retained:")} ${directory ?? t("Unavailable")}\n${String(error)}`,
            0,
          );
        }
      }
      if (directory && safelyStored) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error) {
          new Notice(`Could not clean up temporary upload: ${String(error)}`);
        }
      }
    }
  }

  private replaceMarker(editor: Editor, marker: string, replacement: string): boolean {
    const text = editor.getValue();
    const index = text.indexOf(marker);
    if (index < 0) return false;
    editor.replaceRange(
      replacement,
      editor.offsetToPos(index),
      editor.offsetToPos(index + marker.length),
    );
    return true;
  }

  private async replaceSourceMarker(
    editor: Editor,
    marker: string,
    replacement: string,
    sourcePath: string,
  ): Promise<boolean> {
    // The unique marker identifies the original insertion even if selection moved.
    if (this.replaceMarker(editor, marker, replacement)) return true;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.isDeferred) continue;
      const view = leaf.view as MarkdownView;
      if (view.file?.path !== sourcePath || !view.editor) continue;
      if (this.replaceMarker(view.editor, marker, replacement)) return true;
    }
    const file = this.app.vault.getFileByPath(sourcePath);
    if (!file) return false;
    let replaced = false;
    await this.app.vault.process(file, (content) => {
      if (!content.includes(marker)) return content;
      replaced = true;
      return content.replace(marker, () => replacement);
    });
    return replaced;
  }

  private async fallbackToVault(
    file: File,
    editor: Editor,
    marker: string,
    sourcePath: string,
  ): Promise<boolean> {
    let storedPath: string | null = null;
    try {
      const path = await this.app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
      const saved = await this.app.vault.createBinary(path, await file.arrayBuffer());
      storedPath = saved.path;
      const link = this.app.fileManager.generateMarkdownLink(saved, sourcePath);
      const extension = saved.extension.toLowerCase();
      const embed = /^(png|jpe?g|gif|svg|webp|avif|bmp|mp3|wav|m4a|mp4|webm|mov|pdf)$/.test(
        extension,
      );
      const markup = embed && !link.startsWith("!") ? `!${link}` : link;
      if (!(await this.replaceSourceMarker(editor, marker, markup, sourcePath))) {
        new Notice(`Attachment saved locally but placeholder was removed: ${saved.path}`, 10000);
      }
      return true;
    } catch (error) {
      if (storedPath) {
        new Notice(`${t("Attachment recovery copy saved:")} ${storedPath}\n${String(error)}`, 0);
        return true;
      }
      new Notice(`Failed to preserve attachment locally: ${String(error)}`, 10000);
      return false;
    }
  }

  /**
   * 加载插件设置
   */
  async loadSettings() {
    this.settings = parseSettings(await this.loadData());
  }

  /**
   * 保存插件设置
   */
  async saveSettings() {
    await this.saveData(serializeSettings(this.settings));
  }
}
