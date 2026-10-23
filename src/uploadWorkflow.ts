import type { ViewUpdate } from "@codemirror/view";
import {
  editorInfoField,
  Notice,
  type App,
  type Editor,
  type MarkdownFileInfo,
  type MarkdownView,
} from "obsidian";

import { ImageReferenceTracker } from "./attachments/imageReferenceTracker";
import { applyTextChanges } from "./attachments/imageRewriter";
import {
  collectRemoteImageReferences,
  hasPotentialImageReferenceSyntax,
} from "./attachments/markdown";
import { AttachmentMatcher } from "./attachments/vaultAttachments";
import { FileInsertion } from "./fileInsertion";
import { t } from "./lang/helpers";
import type { PluginSettings } from "./settings";
import { RemoteImageDownloader } from "./upload/imageDownloader";
import { LocalAttachments } from "./upload/localAttachments";
import { preserveUploadReceipt } from "./upload/recovery";
import {
  captureRemoteImageReferences,
  emptyTransferSummary,
  ImageTransferService,
  MAX_UNIQUE_REMOTE_IMAGES,
  remoteImageSessionKey,
  rememberSessionOutput,
  compileRemoteHostPrefixes,
  isOwnRemoteImageUrl,
  type RemoteImageScope,
  type TransferDocumentAccess,
  type TransferProgress,
  type TransferSummary,
} from "./upload/remoteImages";
import {
  Uploader,
  UploadCancelledError,
  type UploadFile,
  type UploadResult,
} from "./upload/uploader";

interface RemoteTransferTarget {
  generation: number;
  manualPrefixes: string[];
  formats: Set<string>;
  upload: UploadFile;
  outputs: Set<string>;
}

interface TransferTask {
  controller: AbortController;
  onProgress: (progress: TransferProgress) => void;
}

export class UploadWorkflow {
  app: App;
  settings: PluginSettings;
  readonly fileInsertion: FileInsertion;
  private readonly uploader: Uploader;
  private readonly manualUploads = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly remoteTransfers = new Map<
    string,
    { promise: Promise<TransferSummary>; controller: AbortController }
  >();
  private readonly remoteQueues = new Map<string, Promise<unknown>>();
  private remoteOutputUrls = new Set<string>();
  private remoteTargetKey: string | null = null;
  private remoteTargetGeneration = 0;
  private readonly referenceTrackers = new Map<Editor, Map<ImageReferenceTracker, string>>();
  private _attachmentMatcher?: AttachmentMatcher;

  constructor(app: App, settings: PluginSettings, uploader = new Uploader()) {
    this.app = app;
    this.settings = settings;
    this.uploader = uploader;
    this.fileInsertion = new FileInsertion(
      app,
      () => this.settings.uploadFileFormat,
      (path) => this.uploadFile(path),
    );
  }

  dispose(): void {
    for (const entry of this.remoteTransfers.values()) entry.controller.abort();
    for (const entry of this.manualUploads.values()) entry.controller.abort();
    for (const editor of this.referenceTrackers.keys()) this.detachEditor(editor);
    this.referenceTrackers.clear();
  }

  detachEditor(editor: Editor): void {
    for (const tracker of this.referenceTrackers.get(editor)?.keys() ?? []) tracker.detach();
    this.referenceTrackers.delete(editor);
  }

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

  get localAttachments(): LocalAttachments {
    return new LocalAttachments(
      this.captureUpload(),
      this.settings.isDeleteSourceFile,
      new Set(this.settings.uploadFileFormat),
    );
  }

  private captureUpload(): UploadFile {
    this.syncRemoteTarget();
    const outputs = this.remoteOutputUrls;
    const command = this.settings.uploadCommand;
    return async (path, signal) =>
      await this.uploader.uploadFile(path, {
        command,
        signal,
        onSuccess: (url) => rememberSessionOutput(outputs, url),
      });
  }

  async uploadFile(path: string, signal?: AbortSignal): Promise<UploadResult> {
    return await this.captureUpload()(path, signal);
  }

  /**
   * 上传编辑器中的附件
   * 获取当前编辑器中的附件，并逐个处理上传
   */
  async uploadCurrentNote(): Promise<void> {
    const view = this.app.workspace.activeEditor;
    if (!view?.file || !view.editor) return;
    const path = view.file.path;
    const existing = this.manualUploads.get(path);
    if (existing) {
      await existing.promise;
      return;
    }
    const controller = new AbortController();
    const promise = this.uploadNoteAttachments(view, controller);
    this.manualUploads.set(path, { controller, promise });
    try {
      await promise;
    } finally {
      if (this.manualUploads.get(path)?.promise === promise) this.manualUploads.delete(path);
    }
  }

  private async uploadNoteAttachments(
    view: MarkdownFileInfo,
    controller: AbortController,
  ): Promise<void> {
    const sourceFile = view.file;
    if (!sourceFile || !view.editor) return;
    const summary = emptyTransferSummary();
    const uploader = this.localAttachments;
    const progress = this.createUploadProgress(controller);
    const task: TransferTask = { controller, onProgress: progress.update };
    try {
      if (collectRemoteImageReferences(view.editor.getValue()).references.length) {
        const remote = await this.startRemoteTransfer(
          sourceFile.path,
          { kind: "note" },
          view,
          task,
        );
        if (remote) Object.assign(summary, remote);
        else summary.failed += 1;
      }
      if (controller.signal.aborted || view.file !== sourceFile) {
        summary.cancelled = true;
        return;
      }
      // Re-read local references after remote replacements. Newly uploaded
      // local links are never included in the preceding remote phase.
      const attachments = Array.from(
        new Map(
          uploader
            .filterUploadableAttachments(this.attachmentMatcher.getEditorAttachments(view))
            .map((attachment) => [attachment.inVaultPath, attachment]),
        ).values(),
      );
      summary.totalReferences += attachments.length;
      let completed = 0;
      for (const attachment of attachments) {
        if (controller.signal.aborted || view.file !== sourceFile) {
          summary.cancelled = true;
          break;
        }
        progress.update({ total: attachments.length, completed, phase: "uploading" });
        try {
          const status = await uploader.processAttachment(
            attachment,
            view,
            this.app,
            controller.signal,
          );
          summary[status] += 1;
        } catch (error) {
          if (!(controller.signal.aborted && error instanceof UploadCancelledError))
            summary.failed += 1;
        }
        completed += 1;
      }
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ code: String(error), url: sourceFile.path });
    } finally {
      summary.cancelled ||= controller.signal.aborted;
      progress.close();
      this.showUploadSummary(summary);
    }
  }

  /**
   * 处理粘贴上传
   */
  async handlePaste(evt: ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo) {
    if (!this.settings.autoUpload) return;
    const items = evt.clipboardData?.items;
    if (!items) return;

    const fileItems = Array.from(items).filter((item) => item.kind === "file");
    if (fileItems.length) {
      const files = fileItems
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      await this.fileInsertion.handle(evt, files, editor, info.file?.path ?? "");
      return;
    }

    if (evt.defaultPrevented) return;
    if (!this.settings.autoTransferRemoteImages) return;
    this.handleRemoteMarkdownPaste(evt, editor, info);
  }

  /**
   * 处理拖拽上传
   */
  async handleDrop(evt: DragEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo) {
    if (!this.settings.autoUpload) return;
    const files = evt.dataTransfer?.files;
    if (!files || files.length === 0) return;
    await this.fileInsertion.handle(evt, Array.from(files), editor, info.file?.path ?? "");
  }

  private resetRemoteSession(): void {
    // Replace, rather than clear: old jobs retain a detached set and cannot
    // populate the new target's records even if their processes finish later.
    this.remoteOutputUrls = new Set();
    this.remoteTargetGeneration += 1;
  }

  private syncRemoteTarget(): void {
    const key = JSON.stringify([this.settings.uploadService, this.settings.uploadCommand]);
    if (key === this.remoteTargetKey) return;
    this.remoteTargetKey = key;
    this.resetRemoteSession();
  }

  private captureRemoteTarget(): RemoteTransferTarget {
    this.syncRemoteTarget();
    return {
      generation: this.remoteTargetGeneration,
      manualPrefixes: [...this.settings.remoteImageSkipPrefixes],
      formats: new Set(this.settings.uploadFileFormat),
      upload: this.captureUpload(),
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

  updateEditor(update: ViewUpdate): void {
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

  private manualRemotePrefixes() {
    return compileRemoteHostPrefixes(this.settings.remoteImageSkipPrefixes);
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
    view: MarkdownView | MarkdownFileInfo,
    task?: TransferTask,
  ): Promise<TransferSummary | null> {
    const target = this.captureRemoteTarget();
    this.captureReferenceScope(scope, view);
    const key = JSON.stringify([
      target.generation,
      filePath,
      scope.kind,
      scope.start,
      scope.end,
      view.editor?.getValue(),
    ]);
    const existing = this.remoteTransfers.get(key);
    if (existing) {
      this.releaseReferenceScope(scope);
      try {
        return await existing.promise;
      } catch (error) {
        if (!task) new Notice(`${t("Remote image transfer failed:")} ${String(error)}`, 7000);
        return null;
      }
    }

    const controller = task?.controller ?? new AbortController();
    const promise = this.enqueueRemoteTransfer(filePath, () =>
      this.executeRemoteImageTransfer(filePath, scope, view, controller, target, task),
    );
    this.remoteTransfers.set(key, { promise, controller });
    try {
      return await promise;
    } catch (error) {
      if (!task) new Notice(`${t("Remote image transfer failed:")} ${String(error)}`, 7000);
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
    view: MarkdownView | MarkdownFileInfo,
    controller: AbortController,
    target: RemoteTransferTarget,
    task?: TransferTask,
  ): Promise<TransferSummary> {
    const prefixes = compileRemoteHostPrefixes(target.manualPrefixes);
    const downloader = new RemoteImageDownloader();
    const progress = task ? null : this.createUploadProgress(controller);
    const onProgress = task?.onProgress ?? progress?.update;

    const transferService = new ImageTransferService({
      document: this.createRemoteDocument(filePath, view, controller.signal),
      downloader,
      upload: async (path: string) => await target.upload(path, controller.signal),
      preserveReceipt: preserveUploadReceipt,
      sessionOutputs: target.outputs,
    });

    try {
      const summary = await transferService.transfer({
        sourcePath: filePath,
        scope,
        settings: {
          uploadFileFormat: target.formats,
          prefixes,
        },
        signal: controller.signal,
        onProgress,
      });
      if (!task) this.showUploadSummary(summary);
      return summary;
    } finally {
      progress?.close();
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

  private createUploadProgress(controller: AbortController) {
    const notice = new Notice(t("Uploading attachments..."), 0);
    const text = notice.messageEl.createEl("span");
    const cancel = notice.messageEl.createEl("button", { text: t("Cancel") });
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      cancel.textContent = t("Cancelling...");
      controller.abort();
    });
    return {
      update: (progress: TransferProgress) => {
        const phase =
          progress.phase === "downloading"
            ? t("Downloading")
            : progress.phase === "uploading"
              ? t("Uploading")
              : t("Applying");
        text.textContent = ` ${progress.completed}/${progress.total} · ${phase}`;
      },
      close: () => notice.hide(),
    };
  }

  private showUploadSummary(summary: TransferSummary): void {
    if (summary.totalReferences === 0 && summary.failed === 0 && !summary.limitExceeded) {
      new Notice(
        summary.cancelled
          ? t("Upload cancelled.")
          : t("No attachment matching the upload conditions was found."),
      );
      return;
    }
    const parts = [
      `${t("Uploaded:")} ${summary.succeeded}`,
      `${t("Failed:")} ${summary.failed}`,
      `${t("Skipped:")} ${summary.skipped}`,
    ];
    if (summary.limitExceeded)
      parts.push(
        t("A maximum of {limit} remote image URLs can be transferred at once.").replace(
          "{limit}",
          String(MAX_UNIQUE_REMOTE_IMAGES),
        ),
      );
    if (summary.notApplied) parts.push(`${t("Not applied:")} ${summary.notApplied}`);
    if (summary.cancelled) parts.push(t("Upload cancelled."));
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

    this.syncRemoteTarget();
    const manualPrefixes = this.manualRemotePrefixes();
    const sessionOutputs = this.remoteOutputUrls;
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
    void this.startRemoteTransfer(filePath, scope, info);
  }
}
