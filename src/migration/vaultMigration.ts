import { type App, type TFile } from "obsidian";

import {
  applyTextChanges,
  formatUploadedFile,
  type TextChange,
} from "../attachments/imageRewriter";
import { collectRemoteImageReferences } from "../attachments/markdown";
import { AttachmentMatcher, type Attachment } from "../attachments/vaultAttachments";
import type { PluginSettings } from "../settings";
import {
  RemoteImageDownloader,
  RemoteImageDownloadError,
  type DownloadedImage,
} from "../upload/imageDownloader";
import { preserveUploadReceipt } from "../upload/recovery";
import {
  ImageTransferService,
  compileRemoteHostPrefixes,
  isOwnRemoteImageUrl,
  remoteImageSessionKey,
  type TransferDownloader,
} from "../upload/remoteImages";
import type { UploadFile } from "../upload/uploader";
import {
  isExcludedPath,
  type MigrationBackend,
  type MigrationContext,
  type MigrationInspection,
  type MigrationResult,
} from "./batchMigration";

interface FileVersion {
  file: TFile;
  size: number;
  mtime: number;
}
interface LocalResult extends FileVersion {
  url: string;
}
interface RemoteResult {
  url: string;
  extension: string;
}

/** Vault adapter: prepare changes in memory, then conditionally update one closed note. */
export class VaultMigration implements MigrationBackend {
  private readonly app: App;
  private readonly getSettings: () => PluginSettings;
  private readonly captureUpload: () => UploadFile;
  private readonly getOutputs: () => Set<string>;
  private readonly matcher: AttachmentMatcher;
  private readonly localResults = new Map<string, LocalResult>();
  private readonly remoteResults = new Map<string, RemoteResult>();
  private formats: ReadonlySet<string> = new Set();
  private prefixes = compileRemoteHostPrefixes([]);
  private outputs = new Set<string>();
  private excluded: readonly string[] = [];
  private settingsKey = "";
  private upload?: UploadFile;

  constructor(
    app: App,
    getSettings: () => PluginSettings,
    captureUpload: () => UploadFile,
    getOutputs: () => Set<string>,
  ) {
    this.app = app;
    this.getSettings = getSettings;
    this.captureUpload = captureUpload;
    this.getOutputs = getOutputs;
    this.matcher = new AttachmentMatcher(app);
  }

  private currentKey(): string {
    const settings = this.getSettings();
    return JSON.stringify([
      settings.uploadService,
      settings.uploadCommand,
      [...settings.uploadFileFormat].sort(),
      settings.remoteImageSkipPrefixes,
    ]);
  }

  prepare(excluded: readonly string[]): void {
    this.settingsKey = this.currentKey();
    this.excluded = [...excluded];
    this.formats = new Set(this.getSettings().uploadFileFormat);
    this.prefixes = compileRemoteHostPrefixes(this.getSettings().remoteImageSkipPrefixes);
    this.upload = this.captureUpload();
    this.outputs = this.getOutputs();
    this.localResults.clear();
    this.remoteResults.clear();
  }

  isCurrent(): boolean {
    return this.settingsKey === this.currentKey();
  }
  listNotes(): string[] {
    return this.app.vault.getMarkdownFiles().map((file) => file.path);
  }

  private attachments(file: TFile, content: string): Attachment[] {
    return this.matcher
      .getEditorAttachments({ file, editor: { getValue: () => content } })
      .filter(
        (attachment) =>
          this.formats.has(attachment.ext.toLowerCase()) &&
          !isExcludedPath(attachment.inVaultPath, this.excluded),
      );
  }

  private remoteUrls(content: string): string[] {
    return collectRemoteImageReferences(content)
      .references.map((reference) => reference.url)
      .filter(
        (url) =>
          !this.outputs.has(remoteImageSessionKey(url)) && !isOwnRemoteImageUrl(url, this.prefixes),
      );
  }

  async inspect(path: string): Promise<MigrationInspection> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new Error("note-missing");
    const content = await this.app.vault.read(file);
    const attachments = this.attachments(file, content);
    return {
      localPaths: attachments
        .filter((attachment) => attachment.existenceState === "local")
        .map((attachment) => attachment.inVaultPath),
      remoteUrls: this.remoteUrls(content),
      missing: attachments.filter((attachment) => attachment.existenceState === "missing").length,
    };
  }

  private isOpen(path: string): boolean {
    return this.app.workspace.getLeavesOfType("markdown").some((leaf) => {
      if (leaf.isDeferred) return false;
      const view = leaf.view;
      return "file" in view && (view.file as TFile | null)?.path === path;
    });
  }

  private async version(path: string): Promise<FileVersion | null> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return null;
    const stat = await this.app.vault.adapter.stat(path);
    if (!stat || stat.type !== "file") return null;
    return { file, size: stat.size, mtime: stat.mtime };
  }

  private sameVersion(first: FileVersion, second: FileVersion | null): boolean {
    return (
      second !== null &&
      first.file === second.file &&
      first.file.path === second.file.path &&
      first.size === second.size &&
      first.mtime === second.mtime
    );
  }

  async migrate(path: string, context: MigrationContext): Promise<MigrationResult> {
    const result: MigrationResult = {
      path,
      status: "skipped",
      updated: 0,
      failed: 0,
      reused: 0,
      notApplied: 0,
    };
    const note = this.app.vault.getFileByPath(path);
    if (!note) return { ...result, reason: "note-missing" };
    if (this.isOpen(path)) return { ...result, reason: "open-note" };
    const uploaded = new Map<string, string>();
    const receipted = new Set<string>();
    const applicable = new Set<string>();
    const localVersions = new Map<string, FileVersion>();
    let committed = false;
    const receipt = async (url: string, _sourcePath: string, filename: string) => {
      if (receipted.has(url)) return;
      await preserveUploadReceipt(url, path, filename);
      receipted.add(url);
    };
    const checkpoint = async (item?: string) => {
      await context.checkpoint(item);
      context.signal.throwIfAborted();
      if (!this.isCurrent()) throw new Error("settings-changed");
    };
    const downloader = new RemoteImageDownloader();
    try {
      const original = await this.app.vault.read(note);
      let working = original;
      // Source notes remain untouched until all applicable changes are ready.
      if (this.remoteUrls(original).length) {
        const files = new Map<
          string,
          { source: string; image: DownloadedImage; cached?: RemoteResult }
        >();
        let cachedId = 0;
        const downloads: TransferDownloader = {
          download: async (url, options) => {
            await checkpoint(url);
            const cached = this.remoteResults.get(url);
            if (cached) {
              const image = {
                path: `cached-image-${++cachedId}`,
                extension: cached.extension,
                bytes: 0,
              };
              files.set(image.path, { source: url, image, cached });
              return image;
            }
            try {
              const image = await downloader.download(url, options);
              files.set(image.path, { source: url, image });
              return image;
            } catch (error) {
              if (!context.signal.aborted)
                context.failed(error instanceof RemoteImageDownloadError && error.status === 429);
              throw error;
            }
          },
          release: async (filePath) => {
            const entry = files.get(filePath);
            if (!entry?.cached) await downloader.release(filePath);
            files.delete(filePath);
          },
        };
        const transfer = new ImageTransferService({
          document: {
            read: async () => ({ content: working, live: false }),
            apply: async (snapshot, changes) => {
              if (context.signal.aborted || working !== snapshot) return false;
              working = applyTextChanges(working, changes);
              return true;
            },
          },
          downloader: downloads,
          upload: async (filePath) => {
            await checkpoint();
            const entry = files.get(filePath);
            if (!entry || !this.upload) throw new Error("missing-download");
            if (entry.cached) {
              result.reused += 1;
              uploaded.set(entry.cached.url, "remote-image");
              return { success: true, url: entry.cached.url };
            }
            const outcome = await this.upload(filePath, context.signal);
            if (outcome.success && outcome.url) {
              context.succeeded();
              this.remoteResults.set(entry.source, {
                url: outcome.url,
                extension: entry.image.extension,
              });
              uploaded.set(outcome.url, "remote-image");
            } else context.failed();
            return outcome;
          },
          preserveReceipt: receipt,
          sessionOutputs: this.outputs,
        });
        const summary = await transfer.transfer({
          sourcePath: path,
          scope: { kind: "note" },
          settings: {
            uploadFileFormat: new Set(this.formats),
            prefixes: this.prefixes,
            downloadConcurrency: 1,
          },
          signal: context.signal,
        });
        result.updated += summary.succeeded;
        result.failed += summary.failed;
        if (summary.limitExceeded) {
          result.reason = "image-limit";
          result.failed += 1;
        }
        if (summary.succeeded)
          for (const url of uploaded.keys()) if (!receipted.has(url)) applicable.add(url);
      }
      const locals = this.attachments(note, working).filter(
        (attachment) => attachment.existenceState === "local",
      );
      const groups = new Map<string, Attachment[]>();
      for (const attachment of locals) {
        const group = groups.get(attachment.inVaultPath) ?? [];
        group.push(attachment);
        groups.set(attachment.inVaultPath, group);
      }
      const changes: TextChange[] = [];
      for (const [source, references] of groups) {
        await checkpoint(source);
        const before = await this.version(source);
        if (!before) {
          result.failed += 1;
          result.reason = "source-changed";
          continue;
        }
        let url: string | undefined;
        const cached = this.localResults.get(source);
        if (cached && this.sameVersion(cached, before)) {
          url = cached.url;
          result.reused += 1;
        } else {
          if (!this.upload) throw new Error("missing-uploader");
          const outcome = await this.upload(references[0]!.inSystemPath, context.signal);
          if (!outcome.success || !outcome.url) {
            result.failed += 1;
            result.reason = "upload-error";
            result.details = outcome.errorMessage;
            context.failed();
            continue;
          }
          url = outcome.url;
          context.succeeded();
        }
        uploaded.set(url, references[0]!.basename);
        if (!this.sameVersion(before, await this.version(source))) {
          result.failed += 1;
          result.reason = "source-changed";
          continue;
        }
        this.localResults.set(source, { ...before, url });
        localVersions.set(source, before);
        applicable.add(url);
        for (const reference of references)
          changes.push({
            start: reference.start,
            end: reference.end,
            text: formatUploadedFile(reference.basename, url),
          });
        result.updated += 1;
      }
      await checkpoint();
      for (const [source, version] of localVersions) {
        if (!this.sameVersion(version, await this.version(source))) {
          result.reason = "source-changed";
          result.updated = 0;
          return result;
        }
      }
      working = applyTextChanges(working, changes);
      if (working === original) {
        result.reason ??= "no-attachments";
        return result;
      }
      let applied = false;
      await this.app.vault.process(note, (current) => {
        if (
          context.signal.aborted ||
          this.isOpen(path) ||
          note.path !== path ||
          this.app.vault.getFileByPath(path) !== note ||
          current !== original
        )
          return current;
        applied = true;
        return working;
      });
      committed = applied;
      if (!committed) {
        result.updated = 0;
        result.reason = this.isOpen(path) ? "open-note" : "note-changed";
      } else result.status = "updated";
      return result;
    } catch (error) {
      result.updated = 0;
      result.reason = context.signal.aborted ? "cancelled" : "read-error";
      result.status = context.signal.aborted ? "skipped" : "failed";
      if (!context.signal.aborted) {
        result.failed += 1;
        result.details = String(error);
      }
      return result;
    } finally {
      if (!committed) result.updated = 0;
      for (const [url, filename] of uploaded) {
        if (!committed || !applicable.has(url)) await receipt(url, path, filename);
      }
      result.notApplied = receipted.size;
      if (result.status !== "updated" && result.failed) result.status = "failed";
      await downloader.dispose();
    }
  }
}
