import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  editorInfoField,
  type Editor,
  type FileSystemAdapter,
  type MarkdownFileInfo,
  MarkdownView,
  type Menu,
  Notice,
  Plugin,
  type TAbstractFile,
  TFile,
} from "obsidian";

import {
  type AttachmentMatcher as AttachmentMatcherType,
  AttachmentMatcher,
  collectRemoteImageReferences,
  findRemoteImageAtOffset,
  hasPotentialImageReferenceSyntax,
} from "./attachmentMatcher";
import { t } from "./lang/helpers";
import { ImageReferenceTracker } from "./services/imageReferenceTracker";
import {
  captureRemoteImageReferences,
  ImageTransferService,
  remoteImageSessionKey,
  type RemoteImageScope,
  type RemoteImageTransferMode,
  type TransferDocumentAccess,
  type TransferProgress,
  type TransferSummary,
} from "./services/imageTransferService";
import { RemoteImageDownloader } from "./services/remoteImageDownloader";
import { applyTextChanges } from "./services/remoteImageRewriter";
import { UploadCommandQueue } from "./services/uploadCommandQueue";
import { preserveUploadReceipt } from "./services/uploadReceipts";
import { UploadService, type UploadTasks } from "./services/uploadService";
import {
  compileRemoteHostPrefixes,
  isOwnRemoteImageUrl,
  resolveUploadTarget,
  suggestPrefixFromSampleUrl,
  type UploadTargetDetection,
} from "./services/uploadTargetResolver";
import {
  parseSettings,
  remoteImageRuleScopeKey,
  serializeSettings,
  type PluginSettings,
} from "./settings";
import { SettingTab } from "./settingsTab";

interface RemoteTransferTarget {
  generation: number;
  key: string;
  service: PluginSettings["uploadService"];
  command: string;
  autoDetect: boolean;
  manualPrefixes: string[];
  formats: Set<string>;
  uploader: UploadService;
  outputs: Set<string>;
}

export default class AttachmentUploader extends Plugin {
  declare settings: PluginSettings;
  private readonly autoUploadsInFlight = new Set<string>();
  private readonly uploadTasks: UploadTasks = new Map();
  private readonly manualUploadsInFlight = new Set<string>();
  private readonly remoteTransfers = new Map<
    string,
    { promise: Promise<TransferSummary>; controller: AbortController }
  >();
  private readonly remoteQueues = new Map<string, Promise<unknown>>();
  private remoteOutputUrls = new Set<string>();
  private remoteTargetKey: string | null = null;
  private remoteTargetGeneration = 0;
  private remoteTargetFingerprint: string | null = null;
  private readonly remoteUploadQueue = new UploadCommandQueue();
  private readonly referenceTrackers = new Map<Editor, Map<ImageReferenceTracker, string>>();
  private lastSuccessfulUploadUrl: string | null = null;
  private lastSuccessfulUploadScope: string | null = null;
  private remoteDetectionWarningShown = false;
  private _attachmentMatcher?: AttachmentMatcherType;

  /**
   * 懒加载附件匹配器
   */
  get attachmentMatcher(): AttachmentMatcherType {
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
    this.syncRemoteTarget();
    const scope = this.remoteImageScopeKey();
    const generation = this.remoteTargetGeneration;
    return new UploadService(
      this.settings.uploadCommand,
      this.settings.isDeleteSourceFile,
      this.settings.uploadFileFormat,
      this.uploadTasks,
      (url) => {
        this.syncRemoteTarget();
        if (generation !== this.remoteTargetGeneration) return;
        this.lastSuccessfulUploadUrl = url;
        this.lastSuccessfulUploadScope = scope;
      },
    );
  }

  /**
   * 上传文件（委托给 UploadService，供设置页「上传测试」调用）
   */
  uploadServe(path: string): ReturnType<UploadService["uploadServe"]> {
    return this.uploadService.uploadServe(path);
  }

  /**
   * Run a fresh read-only target detection and persist only its bounded public
   * prefixes. Stale results are removed when detection fails.
   */
  async detectRemoteImageHost(): Promise<UploadTargetDetection> {
    this.syncRemoteTarget();
    const key = this.remoteImageScopeKey();
    const generation = this.remoteTargetGeneration;
    const detection = await resolveUploadTarget({
      service: this.settings.uploadService,
      command: this.settings.uploadCommand,
    });
    this.syncRemoteTarget();
    if (generation !== this.remoteTargetGeneration) return detection;
    this.acceptRemoteFingerprint(detection.fingerprint);
    if (detection.status === "detected" && detection.fingerprint) {
      this.settings.remoteImageAutoHostRules[key] = {
        prefixes: detection.prefixes,
        source: "uPic",
        detectedAt: new Date().toISOString(),
        fingerprint: detection.fingerprint,
      };
    } else {
      delete this.settings.remoteImageAutoHostRules[key];
    }
    await this.saveSettings();
    return detection;
  }

  clearRemoteImageSession(): void {
    this.resetRemoteSession();
  }

  async clearRemoteImageDetection(): Promise<void> {
    this.resetRemoteSession();
    delete this.settings.remoteImageAutoHostRules[this.remoteImageScopeKey()];
    await this.saveSettings();
  }

  suggestRemoteImagePrefix(): string | null {
    if (
      !this.lastSuccessfulUploadUrl ||
      this.lastSuccessfulUploadScope !== this.remoteImageScopeKey()
    )
      return null;
    return suggestPrefixFromSampleUrl(this.lastSuccessfulUploadUrl);
  }

  /**
   * 插件加载时执行的方法
   * 加载设置，添加功能按钮和命令，设置设置选项卡
   */
  async onload() {
    await this.loadSettings();
    const plugin = this;
    this.registerEditorExtension(
      ViewPlugin.define((view) => ({
        update(update: ViewUpdate) {
          plugin.updateReferenceTrackers(update);
        },
        destroy() {
          const editor = view.state.field(editorInfoField, false)?.editor;
          if (!editor) return;
          for (const tracker of plugin.referenceTrackers.get(editor)?.keys() ?? [])
            tracker.detach();
        },
      })),
    );
    this.register(() => {
      for (const entry of this.remoteTransfers.values()) entry.controller.abort();
      for (const trackers of this.referenceTrackers.values()) {
        for (const tracker of trackers.keys()) tracker.detach();
      }
      this.referenceTrackers.clear();
    });

    this.addRibbonIcon("upload", t("Upload attachments"), this.uploadEditorAttachment.bind(this));

    this.addCommand({
      id: "upload-editor-attachments",
      name: "Upload editor attachments",
      editorCallback: () => this.uploadEditorAttachment(),
    });

    this.addCommand({
      id: "transfer-note-remote-images",
      name: t("Transfer remote images in current note"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (checking) return true;
        void this.transferNoteRemoteImages(view);
        return true;
      },
    });

    this.addCommand({
      id: "transfer-selection-remote-images",
      name: t("Transfer remote images in selection"),
      editorCheckCallback: (checking, editor, view) => {
        const hasSelection = editor.getSelection().length > 0;
        if (checking) return hasSelection;
        if (hasSelection) void this.transferSelectionRemoteImages(editor, view);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        this.addRemoteImageMenuItems(menu, editor, info);
      }),
    );

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

    const fileItems = Array.from(items).filter((item) => item.kind === "file");
    if (fileItems.length) {
      const files = fileItems
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      await this.handleFileInsertion(evt, files, editor, info.file?.path ?? "");
      return;
    }

    if (evt.defaultPrevented) return;
    if (this.settings.remoteImagePastePolicy === "off") return;
    this.handleRemoteMarkdownPaste(evt, editor, info);
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

  private resetRemoteSession(): void {
    // Replace, rather than clear: old jobs retain a detached set and cannot
    // populate the new target's records even if their processes finish later.
    this.remoteOutputUrls = new Set();
    this.remoteTargetGeneration += 1;
    this.lastSuccessfulUploadUrl = null;
    this.lastSuccessfulUploadScope = null;
    this.remoteDetectionWarningShown = false;
  }

  private syncRemoteTarget(): void {
    const key = this.remoteImageScopeKey();
    if (key === this.remoteTargetKey) return;
    this.remoteTargetKey = key;
    this.remoteTargetFingerprint = null;
    this.resetRemoteSession();
  }

  private acceptRemoteFingerprint(fingerprint: string | null): void {
    if (fingerprint === this.remoteTargetFingerprint) return;
    this.remoteTargetFingerprint = fingerprint;
    this.resetRemoteSession();
  }

  private captureRemoteTarget(): RemoteTransferTarget {
    this.syncRemoteTarget();
    return {
      generation: this.remoteTargetGeneration,
      key: this.remoteImageScopeKey(),
      service: this.settings.uploadService,
      command: this.settings.uploadCommand,
      autoDetect: this.settings.remoteImageAutoDetectHost,
      manualPrefixes: [...(this.settings.remoteImageHostRules[this.remoteImageScopeKey()] ?? [])],
      formats: new Set(this.settings.uploadFileFormat),
      uploader: this.uploadService,
      outputs: this.remoteOutputUrls,
    };
  }

  private captureReferenceScope(
    scope: RemoteImageScope,
    view: MarkdownView | MarkdownFileInfo,
  ): void {
    if (scope.tracker || !view.file || !view.editor || !this.isEditableView(view)) return;
    const tracker = captureRemoteImageReferences(view.editor.getValue(), scope);
    scope.tracker = tracker;
    let trackers = this.referenceTrackers.get(view.editor);
    if (!trackers) {
      trackers = new Map();
      this.referenceTrackers.set(view.editor, trackers);
    }
    trackers.set(tracker, view.file.path);
  }

  private releaseReferenceScope(scope: RemoteImageScope): void {
    if (!scope.tracker) return;
    for (const [editor, trackers] of this.referenceTrackers) {
      trackers.delete(scope.tracker);
      if (!trackers.size) this.referenceTrackers.delete(editor);
    }
  }

  private updateReferenceTrackers(update: ViewUpdate): void {
    const before = update.startState.field(editorInfoField, false);
    const after = update.state.field(editorInfoField, false);
    const editor = before?.editor;
    if (!editor) return;
    const trackers = this.referenceTrackers.get(editor);
    if (!trackers) return;
    for (const [tracker, path] of trackers) {
      if (before.file?.path !== path || after?.file?.path !== path || after.editor !== editor) {
        tracker.detach();
      } else if (update.docChanged) {
        // Validate each transaction, not only the final text (delete + undo is
        // still a deleted identity even when a view update batches both).
        for (const transaction of update.transactions) {
          tracker.update(
            transaction.startState.doc.toString(),
            transaction.newDoc.toString(),
            transaction.changes,
          );
        }
      }
    }
  }

  private remoteImageScopeKey(): string {
    return remoteImageRuleScopeKey(this.settings.uploadService, this.settings.uploadCommand);
  }

  private manualRemotePrefixes() {
    return compileRemoteHostPrefixes(
      this.settings.remoteImageHostRules[this.remoteImageScopeKey()] ?? [],
    );
  }

  /**
   * A fresh detection is required before automatic results are trusted. Stored
   * auto rules are never used for filtering; they only describe the last
   * explicit detection in the settings UI.
   */
  private async resolveRemotePrefixes(
    service: PluginSettings["uploadService"],
    command: string,
    autoDetect: boolean,
  ) {
    this.syncRemoteTarget();
    const generation = this.remoteTargetGeneration;
    const key = remoteImageRuleScopeKey(service, command);
    const manual = [...(this.settings.remoteImageHostRules[key] ?? [])];
    const detection =
      autoDetect && service === "uPic" ? await resolveUploadTarget({ service, command }) : null;
    this.syncRemoteTarget();
    if (
      key === this.remoteTargetKey &&
      generation === this.remoteTargetGeneration &&
      autoDetect &&
      service === "uPic"
    ) {
      this.acceptRemoteFingerprint(detection?.fingerprint ?? null);
    }
    return compileRemoteHostPrefixes([
      ...manual,
      ...(detection?.status === "detected" ? detection.prefixes : []),
    ]);
  }

  private remoteScopeKey(scope: RemoteImageScope): string {
    switch (scope.kind) {
      case "note":
        return "note";
      case "selection":
        return `selection:${scope.start ?? 0}-${scope.end ?? 0}`;
      case "paste":
        return `paste:${scope.start ?? 0}-${scope.end ?? 0}`;
      case "image":
        return `image:${scope.imageStart ?? 0}-${scope.imageEnd ?? 0}:${scope.imageUrl ?? ""}`;
    }
  }

  /**
   * Only offer single-image actions when the editor cursor still names a remote
   * image token. Reading-view/other surfaces without a reliable source mapping
   * deliberately show no single-image action.
   */
  private addRemoteImageMenuItems(
    menu: Menu,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): void {
    const filePath = info.file?.path;
    if (!filePath) return;
    const reference = findRemoteImageAtOffset(
      editor.getValue(),
      editor.posToOffset(editor.getCursor()),
    );
    if (reference) {
      menu.addItem((item) =>
        item
          .setTitle(t("Transfer this image"))
          .setIcon("upload")
          .onClick(() => {
            void this.transferImageRemote(editor, info, false);
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle(t("Force re-upload this image"))
          .setIcon("refresh-cw")
          .onClick(() => {
            void this.transferImageRemote(editor, info, true);
          }),
      );
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item
        .setTitle(t("Transfer remote images in current note"))
        .setIcon("download")
        .onClick(() => {
          void this.transferNoteRemoteImages(info);
        }),
    );
    if (editor.getSelection().length > 0) {
      menu.addItem((item) =>
        item
          .setTitle(t("Transfer remote images in selection"))
          .setIcon("text-select")
          .onClick(() => {
            void this.transferSelectionRemoteImages(editor, info);
          }),
      );
    }
  }

  private async transferNoteRemoteImages(view: MarkdownView | MarkdownFileInfo): Promise<void> {
    const filePath = view.file?.path;
    if (!filePath) {
      new Notice(t("This operation needs an open Markdown note."));
      return;
    }
    await this.startRemoteTransfer(filePath, { kind: "note" }, "normal", view);
  }

  private async transferSelectionRemoteImages(
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo,
  ): Promise<void> {
    const filePath = view.file?.path;
    if (!filePath) {
      new Notice(t("This operation needs an open Markdown note."));
      return;
    }
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const start = editor.posToOffset(from);
    const end = editor.posToOffset(to);
    if (start === end) {
      new Notice(t("No selection."));
      return;
    }
    const selectionText = editor.getRange(from, to);
    await this.startRemoteTransfer(
      filePath,
      {
        kind: "selection",
        start,
        end,
        anchorText: selectionText,
      },
      "normal",
      view,
    );
  }

  private async transferImageRemote(
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo,
    force: boolean,
  ): Promise<void> {
    const filePath = view.file?.path;
    if (!filePath) {
      new Notice(t("This operation needs an open Markdown note."));
      return;
    }
    const content = editor.getValue();
    const reference = findRemoteImageAtOffset(content, editor.posToOffset(editor.getCursor()));
    if (!reference) {
      new Notice(t("No remote image was found."));
      return;
    }
    await this.startRemoteTransfer(
      filePath,
      {
        kind: "image",
        imageUrl: reference.url,
        imageStart: reference.start,
        imageEnd: reference.end,
      },
      force ? "force" : "normal",
      view,
    );
  }

  private enqueueRemoteTransfer<T>(notePath: string, task: () => Promise<T>): Promise<T> {
    const previous = this.remoteQueues.get(notePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tracked = next.catch(() => undefined);
    this.remoteQueues.set(notePath, tracked);
    void tracked.then(() => {
      if (this.remoteQueues.get(notePath) === tracked) this.remoteQueues.delete(notePath);
    });
    return next;
  }

  private async startRemoteTransfer(
    filePath: string,
    scope: RemoteImageScope,
    mode: RemoteImageTransferMode,
    view: MarkdownView | MarkdownFileInfo,
  ): Promise<TransferSummary | null> {
    const target = this.captureRemoteTarget();
    this.captureReferenceScope(scope, view);
    const key = JSON.stringify([
      target.generation,
      mode,
      filePath,
      this.remoteScopeKey(scope),
      view.editor?.getValue(),
    ]);
    const existing = this.remoteTransfers.get(key);
    if (existing) {
      this.releaseReferenceScope(scope);
      try {
        return await existing.promise;
      } catch (error) {
        new Notice(`${t("Remote image transfer failed:")} ${String(error)}`, 7000);
        return null;
      }
    }

    const controller = new AbortController();
    const promise = this.enqueueRemoteTransfer(filePath, () =>
      this.executeRemoteImageTransfer(filePath, scope, mode, view, controller, target),
    );
    this.remoteTransfers.set(key, { promise, controller });
    try {
      return await promise;
    } catch (error) {
      new Notice(`${t("Remote image transfer failed:")} ${String(error)}`, 7000);
      return null;
    } finally {
      this.releaseReferenceScope(scope);
      if (this.remoteTransfers.get(key)?.promise === promise) {
        this.remoteTransfers.delete(key);
      }
    }
  }

  private async executeRemoteImageTransfer(
    filePath: string,
    scope: RemoteImageScope,
    mode: RemoteImageTransferMode,
    view: MarkdownView | MarkdownFileInfo,
    controller: AbortController,
    target: RemoteTransferTarget,
  ): Promise<TransferSummary> {
    const autoDetect = target.autoDetect;
    const detection =
      autoDetect && target.service === "uPic"
        ? await resolveUploadTarget({ service: target.service, command: target.command })
        : null;
    this.syncRemoteTarget();
    if (
      target.generation === this.remoteTargetGeneration &&
      autoDetect &&
      target.service === "uPic"
    ) {
      this.acceptRemoteFingerprint(detection?.fingerprint ?? null);
      target.generation = this.remoteTargetGeneration;
      target.outputs = this.remoteOutputUrls;
    }
    const prefixes = compileRemoteHostPrefixes([
      ...target.manualPrefixes,
      ...(detection?.status === "detected" ? detection.prefixes : []),
    ]);
    if (autoDetect && prefixes.length === 0 && !this.remoteDetectionWarningShown) {
      this.remoteDetectionWarningShown = true;
      new Notice(
        t(
          "The current image host could not be detected. Configure prefixes manually to skip images already on your own host.",
        ),
        7000,
      );
    }

    const limits = {
      maxUniqueUrls: this.settings.remoteImageMaxUniqueUrls,
      downloadConcurrency: this.settings.remoteImageDownloadConcurrency,
      maxImageBytes: this.settings.remoteImageMaxImageMiB * 1024 * 1024,
      batchBytes: this.settings.remoteImageBatchMiB * 1024 * 1024,
      downloadTimeoutMs: this.settings.remoteImageDownloadTimeoutSeconds * 1000,
    };
    const downloader = new RemoteImageDownloader({
      maxRedirects: this.settings.remoteImageMaxRedirects,
    });
    const notice = new Notice(t("Transferring remote images..."), 0);
    const progressEl = notice.noticeEl.createEl("span");
    const cancelButton = notice.noticeEl.createEl("button", { text: t("Cancel") });
    cancelButton.addEventListener("click", () => {
      cancelButton.disabled = true;
      controller.abort();
    });
    const onProgress = (progress: TransferProgress) => {
      const phase =
        progress.phase === "downloading"
          ? t("Downloading")
          : progress.phase === "uploading"
            ? t("Uploading")
            : t("Applying");
      progressEl.textContent = ` ${progress.completed}/${progress.total} · ${phase}`;
    };

    const transferService = new ImageTransferService({
      document: this.createRemoteDocument(filePath, view, controller.signal),
      downloader,
      upload: async (path: string) => {
        const result = await this.remoteUploadQueue.enqueue(
          () => target.uploader.uploadServe(path),
          controller.signal,
        );
        this.syncRemoteTarget();
        if (result.success && result.url && target.generation === this.remoteTargetGeneration) {
          this.lastSuccessfulUploadUrl = result.url;
          this.lastSuccessfulUploadScope = target.key;
        }
        return result;
      },
      preserveReceipt: preserveUploadReceipt,
      sessionOutputs: target.outputs,
    });

    try {
      const summary = await transferService.transfer({
        sourcePath: filePath,
        scope,
        mode,
        settings: {
          ...limits,
          uploadFileFormat: target.formats,
          prefixes,
        },
        signal: controller.signal,
        onProgress,
      });
      this.showRemoteTransferSummary(summary, limits.maxUniqueUrls);
      return summary;
    } finally {
      notice.hide();
      await downloader.dispose();
    }
  }

  private createRemoteDocument(
    filePath: string,
    view: MarkdownView | MarkdownFileInfo,
    signal?: AbortSignal,
  ): TransferDocumentAccess {
    const findLive = () => this.findLiveEditor(filePath, view);
    return {
      read: async () => {
        const live = findLive();
        if (live) return { content: live.getValue(), live: true };
        const file = this.app.vault.getFileByPath(filePath);
        if (!file) return null;
        return { content: await this.app.vault.read(file), live: false };
      },
      apply: async (content, changes) => {
        if (signal?.aborted) return false;
        const live = findLive();
        if (live) {
          if (live.getValue() !== content) return false;
          live.transaction({
            changes: changes.map((change) => ({
              from: live.offsetToPos(change.start),
              to: live.offsetToPos(change.end),
              text: change.text,
            })),
          });
          return true;
        }
        const file = this.app.vault.getFileByPath(filePath);
        if (!file) return false;
        let applied = false;
        await this.app.vault.process(file, (current) => {
          if (signal?.aborted || current !== content) return current;
          applied = true;
          return applyTextChanges(current, changes);
        });
        return applied;
      },
    };
  }

  private isEditableView(view: MarkdownView | MarkdownFileInfo): boolean {
    return typeof (view as MarkdownView).getMode === "function"
      ? (view as MarkdownView).getMode() === "source"
      : Boolean(view.editor);
  }

  /**
   * Reading view exposes an editor object too. Applying through it would write
   * outside the visible mode, so only source/Live Preview views count as live.
   */
  private findLiveEditor(filePath: string, view: MarkdownView | MarkdownFileInfo): Editor | null {
    if (view.file?.path === filePath && view.editor && this.isEditableView(view)) {
      return view.editor;
    }
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.isDeferred) continue;
      const candidate = leaf.view as MarkdownView;
      if (candidate.file?.path === filePath && candidate.editor && this.isEditableView(candidate)) {
        return candidate.editor;
      }
    }
    return null;
  }

  private showRemoteTransferSummary(summary: TransferSummary, maxUniqueUrls: number): void {
    if (summary.limitExceeded) {
      new Notice(
        `${t("Too many remote images to transfer in one operation.")} ${t("Maximum unique image URLs per operation")}: ${maxUniqueUrls}`,
        7000,
      );
      return;
    }
    if (summary.totalReferences === 0) {
      new Notice(
        summary.cancelled ? t("Remote image transfer cancelled.") : t("No remote image was found."),
      );
      return;
    }
    const parts = [
      `${t("Transferred:")} ${summary.succeeded}`,
      `${t("Failed:")} ${summary.failed}`,
      `${t("Skipped:")} ${summary.skipped}`,
    ];
    if (summary.notApplied) parts.push(`${t("Not applied:")} ${summary.notApplied}`);
    if (summary.cancelled) parts.push(t("Remote image transfer cancelled."));
    new Notice(parts.join(" · "), 7000);
  }

  private handleRemoteMarkdownPaste(
    evt: ClipboardEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): void {
    const clipboard = evt.clipboardData;
    const filePath = info.file?.path;
    if (!clipboard || !filePath) return;
    // Rich clipboard content is Obsidian's responsibility; never drop its HTML.
    if (clipboard.getData("text/html")) return;
    const text = clipboard.getData("text/plain");
    if (!text) return;
    const fragment = collectRemoteImageReferences(text);
    // Reference images can resolve against definitions already in the note,
    // including fragments that also contain local images.
    const potentialExternalReference = hasPotentialImageReferenceSyntax(text);
    if (
      !fragment.references.length &&
      !fragment.hasUnresolvedReferences &&
      !potentialExternalReference
    ) {
      return;
    }

    // Manual rules and session outputs are authoritative before the event is
    // consumed. Automatic detection is verified asynchronously afterwards.
    this.syncRemoteTarget();
    const manualPrefixes = this.manualRemotePrefixes();
    // uPic may have switched its default host without changing our command.
    // Do not let the old session cache prevent the fresh async detection.
    const sessionOutputs =
      this.settings.remoteImageAutoDetectHost && this.settings.uploadService === "uPic"
        ? new Set<string>()
        : this.remoteOutputUrls;
    const start = editor.posToOffset(editor.getCursor("from"));
    const selectionEnd = editor.posToOffset(editor.getCursor("to"));
    const before = editor.getValue();
    const prospective = before.slice(0, start) + text + before.slice(selectionEnd);
    const transferableFragment = collectRemoteImageReferences(prospective).references.some(
      (reference) =>
        reference.start >= start &&
        reference.end <= start + text.length &&
        !sessionOutputs.has(remoteImageSessionKey(reference.url)) &&
        !isOwnRemoteImageUrl(reference.url, manualPrefixes),
    );
    if (!transferableFragment) return;

    evt.preventDefault();
    const selectedLength = selectionEnd - start;
    const beforeLength = before.length;
    editor.replaceSelection(text);
    const updated = editor.getValue();
    const insertedText = updated.slice(
      start,
      start + updated.length - beforeLength + selectedLength,
    );
    const end = start + insertedText.length;
    const insertedReferences = collectRemoteImageReferences(updated).references.filter(
      (reference) => reference.start >= start && reference.end <= end,
    );
    if (!insertedReferences.length) return;
    const transferable = new Set(
      insertedReferences
        .map((reference) => reference.url)
        .filter(
          (url) =>
            !sessionOutputs.has(remoteImageSessionKey(url)) &&
            !isOwnRemoteImageUrl(url, manualPrefixes),
        ),
    );
    if (!transferable.size) return;

    const scope: RemoteImageScope = {
      kind: "paste",
      start,
      end,
      anchorText: insertedText,
    };
    this.captureReferenceScope(scope, info);
    if (this.settings.remoteImagePastePolicy === "auto") {
      void this.startRemoteTransfer(filePath, scope, "normal", info);
      return;
    }
    void this.promptPasteTransfer(filePath, scope, info, insertedReferences).catch(() =>
      this.releaseReferenceScope(scope),
    );
  }

  private async promptPasteTransfer(
    filePath: string,
    scope: RemoteImageScope,
    info: MarkdownView | MarkdownFileInfo,
    references: ReturnType<typeof collectRemoteImageReferences>["references"],
  ): Promise<void> {
    const prefixes = await this.resolveRemotePrefixes(
      this.settings.uploadService,
      this.settings.uploadCommand,
      this.settings.remoteImageAutoDetectHost,
    );
    const transferable = new Set(
      references
        .map((reference) => reference.url)
        .filter(
          (url) =>
            !this.remoteOutputUrls.has(remoteImageSessionKey(url)) &&
            !isOwnRemoteImageUrl(url, prefixes),
        ),
    );
    if (!transferable.size) {
      this.releaseReferenceScope(scope);
      return;
    }
    const notice = new Notice(
      `${transferable.size} ${t("pasted remote images can be transferred")}`,
      0,
    );
    let handedOff = false;
    const hide = notice.hide.bind(notice);
    notice.hide = () => {
      if (!handedOff) this.releaseReferenceScope(scope);
      hide();
    };
    const button = notice.noticeEl.createEl("button", { text: t("Transfer now") });
    button.addEventListener("click", () => {
      handedOff = true;
      notice.hide();
      void this.startRemoteTransfer(filePath, scope, "normal", info);
    });
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
    this.syncRemoteTarget();
    await this.saveData(serializeSettings(this.settings));
  }
}
