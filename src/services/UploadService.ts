import {
  type App,
  type Editor,
  type MarkdownView,
  Notice,
  TFile,
  type TAbstractFile,
} from "obsidian";

import type { Attachment } from "../attachmentMatcher";
import { t } from "../lang/helpers";
import { extractUrl, toMarkdownUrl } from "./url";
import { executeUploadCommand } from "./command";

const IMAGE_EXTENSION_REGEX = /\.(avif|bmp|gif|jpeg|jpg|png|svg|webp)$/i;

export interface UploadCommandDict {
  [service: string]: string;
}

export const uploadCommandDict: UploadCommandDict = {
  uPic: "/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s",
  Picsee: "/Applications/Picsee.app/Contents/MacOS/Picsee -u %s",
  custom: "",
};

export class UploadService {
  private uploadCommand: string;
  private isDeleteSourceFile: boolean;
  private uploadFileFormat: Set<string>;

  constructor(uploadCommand: string, isDeleteSourceFile: boolean, uploadFileFormat: Set<string>) {
    this.uploadCommand = uploadCommand;
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
  async uploadServe(
    path: string,
  ): Promise<{ success: boolean; url?: string; errorMessage?: string }> {
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
    activeEditor: { editor?: { getValue: () => string; setValue: (content: string) => void } },
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => TAbstractFile | null;
        delete: (file: TFile) => Promise<void>;
      };
    },
  ): Promise<void> {
    const sourceFile = app.vault.getAbstractFileByPath(attachment.inVaultPath);
    const uploadResult = await this.uploadServe(attachment.inSystemPath);

    if (uploadResult.success && uploadResult.url) {
      const replaced = this.updateEditorContent(activeEditor, attachment, uploadResult.url);
      if (!replaced) {
        new Notice(`${t("Upload failed:")} No local reference remains: ${attachment.inVaultPath}`);
        return;
      }
      new Notice(
        `${t("Uploaded attachment:")}${attachment.inVaultPath}\n${t("Replace with:")}${uploadResult.url}`,
      );
      if (this.isDeleteSourceFile && sourceFile instanceof TFile) {
        // Preserve an attachment if any other note may still refer to it.
        const safeToTrash = await this.noRemainingReferences(app as App, sourceFile);
        if (safeToTrash) {
          await (app as App).vault.trash(sourceFile, false);
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
    editor: { editor?: { getValue: () => string; setValue: (content: string) => void } },
    attachment: Attachment,
    newUrl: string,
  ): boolean {
    const active = editor.editor;
    if (!active) return false;
    const content = active.getValue();
    if (!content.includes(attachment.source)) return false;
    const result = content.split(attachment.source).join(this.formatUploadedFile(attachment.name, newUrl));
    active.setValue(result);
    return true;
  }

  formatUploadedFile(filename: string, url: string): string {
    const target = toMarkdownUrl(url);
    return IMAGE_EXTENSION_REGEX.test(filename)
      ? `![${filename}](${target})`
      : `[${filename}](${target})`;
  }

  /** Fail closed: never delete when references remain or the scan fails. */
  private async noRemainingReferences(app: App, file: TFile): Promise<boolean> {
    const names = [file.name, file.path, encodeURI(file.name), encodeURI(file.path)];
    const openEditors = new Map<string, string>();
    for (const leaf of app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file && view.editor) openEditors.set(view.file.path, view.editor.getValue());
    }
    for (const note of app.vault.getFiles()) {
      if (note.extension !== "md" && note.extension !== "canvas") continue;
      const content = openEditors.get(note.path) ?? await app.vault.cachedRead(note);
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
  async replaceLocalLinksInAllEditors(app: App, file: TFile, newUrl: string) {
    const leaves = app.workspace.getLeavesOfType("markdown");

    for (const leaf of leaves) {
      const view = leaf.view;
      if (view && "editor" in view) {
        const markdownView = view as MarkdownView;
        const editor = markdownView.editor;
        if (editor) {
          const content = editor.getValue();

          const escapedPaths = [file.path, file.name].map((path) =>
            path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          );
          let newContent = content;
          for (const escaped of escapedPaths) {
            const wiki = new RegExp(`!\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`, "g");
            const markdown = new RegExp(`!\\[([^\\]]*)\\]\\(<?${escaped}>?\\)`, "g");
            newContent = newContent.replace(wiki, () => this.formatUploadedFile(file.name, newUrl));
            newContent = newContent.replace(markdown, () => this.formatUploadedFile(file.name, newUrl));
          }

          // 如果内容有变化，更新编辑器
          if (newContent !== content) {
            editor.setValue(newContent);
          }
        }
      }
    }
  }
}
