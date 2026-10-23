import { parse } from "node:path";

import {
  normalizePath,
  type DataAdapter,
  type FileSystemAdapter,
  type TFile,
  type MetadataCache,
} from "obsidian";

import { findImages, REMOTE_IMAGE_URL } from "./markdown";

export interface Attachment {
  start: number;
  end: number;
  basename: string;
  alt: string;
  name: string;
  ext: string;
  source: string;
  existenceState: "network" | "local" | "missing";
  inVaultPath: string;
  inSystemPath: string;
}

export class AttachmentMatcher {
  private app: {
    vault: { getFiles: () => TFile[]; adapter: DataAdapter };
    metadataCache?: MetadataCache;
  };

  constructor(app: {
    vault: { getFiles: () => TFile[]; adapter: DataAdapter };
    metadataCache?: MetadataCache;
  }) {
    this.app = app;
  }

  /**
   * 获取编辑器中所有的附件
   * 解析编辑器内容，找出符合条件的附件，条件为符合markdown链接格式![]()
   */
  getEditorAttachments(markdownFile: {
    editor?: { getValue: () => string };
    file?: TFile | null;
  }): Attachment[] {
    const content = markdownFile.editor?.getValue() ?? "";
    const matches = findImages(content);
    if (!matches.length) return [];

    const paths = new Map<string, TFile>();
    const names = new Map<string, TFile | null>();
    if (!this.app.metadataCache) {
      for (const file of this.app.vault.getFiles()) {
        paths.set(file.path.toLowerCase(), file);
        const name = file.name.toLowerCase();
        names.set(name, names.has(name) ? null : file);
      }
    }

    const vaultSystemPath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    return matches
      .map((match) => {
        const { start, end } = match;
        const attachment = this.parseAttachment(
          content.slice(start, end),
          match.path,
          match.alt,
          vaultSystemPath,
          markdownFile.file?.path ?? "",
          paths,
          names,
        );
        return attachment ? { ...attachment, start, end } : null;
      })
      .filter((attachment: Attachment | null): attachment is Attachment => attachment !== null);
  }

  /**
   * 解析单个附件
   * 从匹配的字符串中提取附件信息
   */
  private parseAttachment(
    match: string,
    attSourcePath: string,
    alt: string | undefined,
    vaultSystemPath: string,
    notePath: string,
    paths: Map<string, TFile>,
    names: Map<string, TFile | null>,
  ): Omit<Attachment, "start" | "end"> | null {
    if (!attSourcePath) return null;

    // 确保正确解码 URI 编码的路径；非法 % 序列（如文件名含 %）时保留原串
    let decodedPath: string;
    try {
      decodedPath = decodeURI(attSourcePath);
    } catch {
      decodedPath = attSourcePath;
    }
    const parsedName = parse(normalizePath(decodedPath));

    const isNetwork = REMOTE_IMAGE_URL.test(attSourcePath);
    // An ambiguous basename must never silently upload another folder's file.
    // When Obsidian can resolve links, its note-relative result is authoritative.
    // A failed resolution must not fall back to a different same-named file.
    const searchFile = isNetwork
      ? undefined
      : this.app.metadataCache
        ? this.app.metadataCache.getFirstLinkpathDest(decodedPath, notePath)
        : (paths.get(normalizePath(decodedPath).toLowerCase()) ??
          names.get(parsedName.base.toLowerCase()));

    return {
      source: match,
      alt: alt ?? parsedName.name,
      basename: parsedName.base,
      name: parsedName.name,
      ext: parsedName.ext,
      existenceState: isNetwork ? "network" : searchFile ? "local" : "missing",
      inVaultPath: searchFile ? searchFile.path : normalizePath(decodedPath),
      inSystemPath: searchFile
        ? `${vaultSystemPath}/${searchFile.path}`
        : normalizePath(decodedPath),
    };
  }
}
