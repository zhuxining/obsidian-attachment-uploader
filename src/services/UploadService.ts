import { type App, type Editor, type MarkdownView, Notice, TFile } from "obsidian";

import { AttachmentMatcher, type Attachment } from "../attachmentMatcher";
import { t } from "../lang/helpers";
import { executeUploadCommand } from "./command";
import { extractUrl, toMarkdownUrl } from "./url";

const IMAGE_EXTENSION_REGEX = /\.(avif|bmp|gif|jpeg|jpg|png|svg|webp)$/i;

export type UploadResult = { success: boolean; url?: string; errorMessage?: string };
export type UploadTasks = Map<string, Promise<UploadResult>>;

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

export class UploadService {
  private uploadCommand: string;
  private isDeleteSourceFile: boolean;
  private uploadFileFormat: Set<string>;
  private readonly tasks: UploadTasks;

  constructor(
    uploadCommand: string,
    isDeleteSourceFile: boolean,
    uploadFileFormat: Set<string>,
    tasks: UploadTasks = new Map(),
  ) {
    this.uploadCommand = uploadCommand;
    this.isDeleteSourceFile = isDeleteSourceFile;
    this.uploadFileFormat = uploadFileFormat;
    this.tasks = tasks;
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
   * 检查文件是否可上传
   */
  isUploadableFile(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    return this.uploadFileFormat.has(`.${ext}`);
  }

  /**
   * 过滤符合上传条件的附件列表
   */
  filterUploadableAttachments(attachments: Attachment[]): Attachment[] {
    return attachments.filter((attachment) => this.isValidAttachment(attachment));
  }

  /**
   * 执行上传服务
   * 使用设置的上传命令上传文件
   */
  async uploadServe(path: string): Promise<UploadResult> {
    const key = JSON.stringify([this.uploadCommand, path]);
    const existing = this.tasks.get(key);
    if (existing) return await existing;
    const task = this.executeUpload(path);
    this.tasks.set(key, task);
    try {
      return await task;
    } finally {
      this.tasks.delete(key);
    }
  }

  private async executeUpload(path: string): Promise<UploadResult> {
    try {
      const stdout = await executeUploadCommand(this.uploadCommand, path);
      const url = extractUrl(stdout);
      return url
        ? { success: true, url }
        : { success: false, errorMessage: "No valid upload URL was returned" };
    } catch (err) {
      return { success: false, errorMessage: (err as Error).message };
    }
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
  ): Promise<void> {
    const sourceNote = activeEditor.file;
    const references = new AttachmentMatcher(app).getEditorAttachments(activeEditor);
    if (
      !references.some(
        (candidate) =>
          candidate.existenceState === "local" && candidate.inVaultPath === attachment.inVaultPath,
      )
    )
      return;
    const sourceFile = app.vault.getAbstractFileByPath(attachment.inVaultPath);
    const uploadResult = await this.uploadServe(attachment.inSystemPath);

    if (uploadResult.success && uploadResult.url) {
      // A view can be reused for a different note while the command is running.
      if (activeEditor.file !== sourceNote) return;
      const replaced = this.updateEditorContent(activeEditor, attachment, uploadResult.url, app);
      if (!replaced) {
        new Notice(`${t("Upload failed:")} No local reference remains: ${attachment.inVaultPath}`);
        return;
      }
      new Notice(
        `${t("Uploaded attachment:")}${attachment.inVaultPath}\n${t("Replace with:")}${uploadResult.url}`,
      );
      if (this.isDeleteSourceFile && sourceFile instanceof TFile) {
        // Preserve an attachment if any other note may still refer to it.
        const safeToTrash = await this.noRemainingReferences(app, sourceFile);
        if (safeToTrash) {
          await app.fileManager.trashFile(sourceFile);
          new Notice(`${t("Local attachment deleted")}: ${attachment.inVaultPath}`);
        }
      }
    } else {
      new Notice(
        `${t("Upload failed:")}${attachment.inVaultPath}\n\n${t("Error message:")}\n${uploadResult.errorMessage}`,
      );
    }
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
    replaceAttachments(active, attachments, this.formatUploadedFile(attachment.basename, newUrl));
    return true;
  }

  formatUploadedFile(filename: string, url: string): string {
    const target = toMarkdownUrl(url);
    const label = filename.replace(/[\\[\]]/g, "\\$&");
    return IMAGE_EXTENSION_REGEX.test(filename)
      ? `![${label}](${target})`
      : `[${label}](${target})`;
  }

  /** Fail closed: never delete when references remain or the scan fails. */
  private async noRemainingReferences(app: App, file: TFile): Promise<boolean> {
    const names = [file.name, file.path, encodeURI(file.name), encodeURI(file.path)];
    const openEditors = new Map<string, string>();
    for (const leaf of app.workspace.getLeavesOfType("markdown")) {
      if (leaf.isDeferred) continue;
      const view = leaf.view as MarkdownView;
      if (view.file && view.editor) openEditors.set(view.file.path, view.editor.getValue());
    }
    for (const note of app.vault.getFiles()) {
      if (note.extension !== "md" && note.extension !== "canvas") continue;
      const content = openEditors.get(note.path) ?? (await app.vault.cachedRead(note));
      // URLs containing the same filename are not local references.
      const withoutUrls = content.replace(/https?:\/\/[^\s<>)]+/gi, "");
      if (names.some((name) => withoutUrls.includes(name))) return false;
    }
    return true;
  }

  /**
   * 插入上传后的文件链接
   */
  insertUploadedFile(editor: Editor, filename: string, url: string) {
    editor.replaceRange(this.formatUploadedFile(filename, url), editor.getCursor());
  }

  /**
   * 在所有打开的编辑器中替换本地文件链接
   */
  async replaceLocalLinksInAllEditors(app: App, file: TFile, newUrl: string): Promise<number> {
    const leaves = app.workspace.getLeavesOfType("markdown");
    const matcher = new AttachmentMatcher(app);
    let replacements = 0;

    for (const leaf of leaves) {
      if (leaf.isDeferred) continue;
      const view = leaf.view;
      if (view && "editor" in view) {
        const markdownView = view as MarkdownView;
        const editor = markdownView.editor;
        if (editor && markdownView.file) {
          const attachments = matcher
            .getEditorAttachments(markdownView)
            .filter(
              (attachment) =>
                attachment.existenceState === "local" && attachment.inVaultPath === file.path,
            );
          if (attachments.length) {
            replaceAttachments(editor, attachments, this.formatUploadedFile(file.name, newUrl));
            replacements += attachments.length;
          }
        }
      }
    }
    return replacements;
  }
}
