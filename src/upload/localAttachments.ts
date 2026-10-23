import { type App, type Editor, type MarkdownView, TFile } from "obsidian";

import { formatUploadedFile } from "../attachments/imageRewriter";
import { AttachmentMatcher, type Attachment } from "../attachments/vaultAttachments";
import { preserveUploadReceipt } from "./recovery";
import type { UploadFile } from "./uploader";

const MAX_REFERENCE_DECODE_PASSES = 4;
const MAX_SCAN_NOTES = 128;
const MAX_SCAN_CHARACTERS = 4 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 256 * 1024;
const MAX_SCAN_MS = 100;
const SCAN_YIELD_INTERVAL = 16;
const REMOTE_LINK_REGEX =
  /!?\[(?:\\.|[^\]\\\n])*\]\((?:<https?:\/\/[^>\n]*>|https?:\/\/[^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)\)/gi;
const REMOTE_URL_REGEX = /https?:\/\/[^\s<>)]+/gi;
const PERCENT_BYTES_REGEX = /(?:%[\da-f]{2})+/gi;
const HTML_ENTITY_REGEX = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);/i;
const MARKDOWN_ESCAPE_REGEX = /\\([!-/:-@[-`{-~])/g;

/** Unknown encodings are evidence to preserve the source, not proof of absence. */
function mayReferenceFile(content: string, file: TFile): boolean {
  if (content.length > MAX_TEXT_CHARACTERS) return true;
  let text = content.replace(REMOTE_LINK_REGEX, "").replace(REMOTE_URL_REGEX, "");
  for (let pass = 0; pass < MAX_REFERENCE_DECODE_PASSES; pass++) {
    if (text.includes(file.name) || text.includes(file.path)) return true;
    if (HTML_ENTITY_REGEX.test(text)) return true;
    const decoded = text.replace(PERCENT_BYTES_REGEX, (bytes) => {
      try {
        return decodeURIComponent(bytes);
      } catch {
        // Decode valid ASCII escapes even next to malformed UTF-8 bytes.
        return bytes.replace(/%([\da-f]{2})/gi, (escape, hex: string) => {
          const byte = Number.parseInt(hex, 16);
          return byte < 0x80 ? String.fromCharCode(byte) : escape;
        });
      }
    });
    // Markdown permits backslash escapes for ASCII punctuation in destinations.
    // Normalize after percent decoding too, so encoded escapes cannot hide a reference.
    const unescaped = decoded.replace(MARKDOWN_ESCAPE_REGEX, "$1");
    if (unescaped === text) break;
    text = unescaped;
  }
  return (
    text.includes(file.name) ||
    text.includes(file.path) ||
    /%/.test(text) ||
    HTML_ENTITY_REGEX.test(text)
  );
}

export type AttachmentUploadStatus = "succeeded" | "failed" | "skipped" | "notApplied";

type UploadEditor = Pick<Editor, "getValue" | "offsetToPos" | "transaction">;

function replaceAttachments(
  editor: UploadEditor,
  attachments: Attachment[],
  replacement: string,
): void {
  editor.transaction({
    changes: attachments.map((attachment) => ({
      from: editor.offsetToPos(attachment.start),
      to: editor.offsetToPos(attachment.end),
      text: replacement,
    })),
  });
}

export class LocalAttachments {
  readonly uploadFile: UploadFile;
  private readonly isDeleteSourceFile: boolean;
  private readonly uploadFileFormat: ReadonlySet<string>;

  constructor(
    uploadFile: UploadFile,
    isDeleteSourceFile: boolean,
    uploadFileFormat: ReadonlySet<string>,
  ) {
    this.uploadFile = uploadFile;
    this.isDeleteSourceFile = isDeleteSourceFile;
    this.uploadFileFormat = uploadFileFormat;
  }

  /**
   * 检查附件是否符合上传条件
   */
  private isValidAttachment(attachment: Attachment): boolean {
    return (
      this.uploadFileFormat.has(attachment.ext.toLowerCase()) &&
      attachment.existenceState === "local"
    );
  }

  /**
   * 过滤符合上传条件的附件列表
   */
  filterUploadableAttachments(attachments: Attachment[]): Attachment[] {
    return attachments.filter((attachment) => this.isValidAttachment(attachment));
  }

  /**
   * 处理单个附件
   * 上传附件，更新编辑器内容，显示处理结果
   */
  async processAttachment(
    attachment: Attachment,
    activeEditor: {
      editor?: UploadEditor;
      file?: TFile | null;
    },
    app: App,
    signal?: AbortSignal,
  ): Promise<AttachmentUploadStatus> {
    if (signal?.aborted) return "skipped";
    const sourceNote = activeEditor.file;
    const references = new AttachmentMatcher(app).getEditorAttachments(activeEditor);
    if (
      !references.some(
        (candidate) =>
          candidate.existenceState === "local" && candidate.inVaultPath === attachment.inVaultPath,
      )
    )
      return "skipped";
    const sourceFile = app.vault.getAbstractFileByPath(attachment.inVaultPath);
    const sourcePath = sourceFile?.path;
    let sourceStat: { size: number; mtime: number } | null = null;
    if (this.isDeleteSourceFile && sourceFile instanceof TFile) {
      try {
        const stat = await app.vault.adapter.stat(sourceFile.path);
        if (stat?.type === "file") sourceStat = { size: stat.size, mtime: stat.mtime };
      } catch {
        // Stat failure must not prevent uploading; it only disables deletion.
      }
    }
    if (signal?.aborted) return "skipped";
    const uploadResult = await this.uploadFile(attachment.inSystemPath, signal);

    if (uploadResult.success && uploadResult.url) {
      // A view can be reused for a different note while the command is running.
      let replaced = false;
      try {
        if (!signal?.aborted && activeEditor.file === sourceNote)
          replaced = this.updateEditorContent(activeEditor, attachment, uploadResult.url, app);
      } catch {
        // The command already succeeded; retain its result independently of the editor.
      }
      if (!replaced) {
        await preserveUploadReceipt(uploadResult.url, attachment.inSystemPath, attachment.basename);
        return "notApplied";
      }
      if (this.isDeleteSourceFile && sourceFile instanceof TFile && sourceStat) {
        // Preserve an attachment if any other note may still refer to it.
        const safeToTrash = await this.noRemainingReferences(app, sourceFile);
        if (safeToTrash) {
          try {
            const stat = await app.vault.adapter.stat(sourceFile.path);
            if (
              signal?.aborted ||
              sourceFile.path !== sourcePath ||
              app.vault.getAbstractFileByPath(sourceFile.path) !== sourceFile ||
              stat?.type !== "file" ||
              stat.size !== sourceStat.size ||
              stat.mtime !== sourceStat.mtime ||
              !this.noOpenReferences(app, sourceFile)
            )
              return "succeeded";
          } catch {
            return "succeeded";
          }
          await app.fileManager.trashFile(sourceFile);
        }
      }
      return "succeeded";
    }
    return "failed";
  }

  /**
   * 更新编辑器内容
   * 替换原有的附件链接为新的URL
   */
  private updateEditorContent(
    editor: {
      editor?: UploadEditor;
      file?: TFile | null;
    },
    attachment: Attachment,
    newUrl: string,
    app: App,
  ): boolean {
    const active = editor.editor;
    if (!active) return false;
    const attachments = new AttachmentMatcher(app)
      .getEditorAttachments(editor)
      .filter(
        (candidate) =>
          candidate.existenceState === "local" && candidate.inVaultPath === attachment.inVaultPath,
      );
    if (!attachments.length) return false;
    replaceAttachments(active, attachments, formatUploadedFile(attachment.basename, newUrl));
    return true;
  }

  /** Fail closed: never delete when references remain or the scan fails. */
  private async noRemainingReferences(app: App, file: TFile): Promise<boolean> {
    try {
      const started = performance.now();
      let notesRead = 0;
      let charactersRead = 0;
      if (!this.noOpenReferences(app, file)) return false;
      for (const note of app.vault.getFiles()) {
        if (performance.now() - started >= MAX_SCAN_MS) return false;
        if (note.extension !== "md" && note.extension !== "canvas") continue;
        if (notesRead >= MAX_SCAN_NOTES || performance.now() - started >= MAX_SCAN_MS) return false;
        if (notesRead > 0 && notesRead % SCAN_YIELD_INTERVAL === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (performance.now() - started >= MAX_SCAN_MS) return false;
        }
        const content = await app.vault.cachedRead(note);
        notesRead++;
        charactersRead += content.length;
        if (charactersRead > MAX_SCAN_CHARACTERS || performance.now() - started >= MAX_SCAN_MS)
          return false;
        if (mayReferenceFile(content, file)) return false;
        if (note.extension === "canvas") {
          // JSON.parse resolves Unicode and slash escapes in canvas file nodes.
          const canvas: unknown = JSON.parse(content);
          if (mayReferenceFile(JSON.stringify(canvas), file)) return false;
        }
      }
      return performance.now() - started < MAX_SCAN_MS && this.noOpenReferences(app, file);
    } catch {
      return false;
    }
  }

  private noOpenReferences(app: App, file: TFile): boolean {
    const started = performance.now();
    let characters = 0;
    for (const leaf of app.workspace.getLeavesOfType("markdown")) {
      if (performance.now() - started >= MAX_SCAN_MS) return false;
      if (leaf.isDeferred) continue;
      const view = leaf.view as MarkdownView;
      if (view.editor) {
        const content = view.editor.getValue();
        characters += content.length;
        if (characters > MAX_SCAN_CHARACTERS || mayReferenceFile(content, file)) return false;
      }
    }
    return performance.now() - started < MAX_SCAN_MS;
  }
}
