import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Notice, type App, type Editor, type MarkdownView } from "obsidian";

import { formatUploadedFile } from "./attachments/imageRewriter";
import { t } from "./lang/helpers";
import { preserveUploadReceipt } from "./upload/recovery";
import type { UploadFile } from "./upload/uploader";

export class FileInsertion {
  app: App;
  private readonly getFormats: () => ReadonlySet<string>;
  readonly uploadFile: UploadFile;

  constructor(app: App, getFormats: () => ReadonlySet<string>, uploadFile: UploadFile) {
    this.app = app;
    this.getFormats = getFormats;
    this.uploadFile = uploadFile;
  }

  private isUploadableFile(filename: string): boolean {
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    return this.getFormats().has(`.${extension}`);
  }

  async handle(evt: Event, files: File[], editor: Editor, sourcePath: string) {
    if (evt.defaultPrevented) return;
    // A DOM event is handled as a whole. Mixed batches remain Obsidian's responsibility.
    if (!files.length || files.some((file) => !this.isUploadableFile(file.name))) return;
    evt.preventDefault();
    const pending = files.map((file) => ({
      file,
      marker: `<!-- attachment-uploader:${crypto.randomUUID()} -->`,
    }));
    editor.replaceSelection(pending.map(({ marker }) => marker).join("\n"));
    for (const { file, marker } of pending) {
      await this.insert(file, editor, sourcePath, marker);
    }
  }

  /**
   * 保存临时文件并上传，成功后插入链接到编辑器
   * 粘贴与拖拽共用同一套上传+插入逻辑
   */
  async insert(file: File, editor: Editor, sourcePath: string, reservedMarker?: string) {
    const marker = reservedMarker ?? `<!-- attachment-uploader:${crypto.randomUUID()} -->`;
    if (!reservedMarker) editor.replaceSelection(marker);
    const filename = basename(file.name.replace(/[\\/]/g, "_")) || "attachment.bin";
    let directory: string | null = null;
    let safelyStored = false;
    try {
      directory = await mkdtemp(join(tmpdir(), "obsidian-attachment-uploader-"));
      const temporaryFile = join(directory, filename);
      await writeFile(temporaryFile, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
      const result = await this.uploadFile(temporaryFile);
      if (result.success && result.url) {
        safelyStored = true;
        let didReplace = false;
        try {
          didReplace = await this.replaceSourceMarker(
            editor,
            marker,
            formatUploadedFile(filename, result.url),
            sourcePath,
          );
        } catch {
          // A successful upload must not be reported as a failed cloud command.
        }
        if (!didReplace) await preserveUploadReceipt(result.url, sourcePath, filename);
      } else {
        safelyStored = await this.fallbackToVault(file, editor, marker, sourcePath);
        new Notice(`${t("Upload failed:")} ${result.errorMessage ?? t("Unknown error")}`, 7000);
      }
    } catch (error) {
      safelyStored = await this.fallbackToVault(file, editor, marker, sourcePath);
      new Notice(`${t("Upload failed:")} ${String(error)}`, 7000);
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
          new Notice(`${t("Could not remove temporary files:")} ${String(error)}`);
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
        new Notice(
          `${t("Attachment saved, but its link could not be inserted:")} ${saved.path}`,
          10000,
        );
      }
      return true;
    } catch (error) {
      if (storedPath) {
        new Notice(`${t("Attachment recovery copy saved:")} ${storedPath}\n${String(error)}`, 0);
        return true;
      }
      new Notice(`${t("Could not save the attachment to the vault:")} ${String(error)}`, 10000);
      return false;
    }
  }
}
