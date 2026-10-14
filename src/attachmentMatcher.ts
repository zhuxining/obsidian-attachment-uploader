import { parse } from "node:path";

import { normalizePath, type DataAdapter, type FileSystemAdapter, type TFile, type MetadataCache } from "obsidian";

export interface Attachment {
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
  private app: { vault: { getFiles: () => TFile[]; adapter: DataAdapter }; metadataCache?: MetadataCache };

  constructor(app: { vault: { getFiles: () => TFile[]; adapter: DataAdapter }; metadataCache?: MetadataCache }) {
    this.app = app;
  }

  /**
   * 获取编辑器中所有的附件
   * 解析编辑器内容，找出符合条件的附件，条件为符合markdown链接格式![]()
   */
  getEditorAttachments(markdownFile: { editor?: { getValue: () => string }; file?: TFile | null }): Attachment[] {
    const content = markdownFile.editor?.getValue() ?? "";
    const regex = /!\[\[([^\]]+)\]\]|!\[[^\]\n]*\]\((<[^>\n]+>|(?:\\.|[^()\\\n]|\([^()]*\))+)\)/g;
    const matches = content.match(regex);
    if (!matches) return [];

    const vaultSystemPath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    return matches
      .map((match: string) => this.parseAttachment(match, vaultSystemPath, markdownFile.file?.path ?? ""))
      .filter((attachment: Attachment | null): attachment is Attachment => attachment !== null);
  }

  /**
   * 解析单个附件
   * 从匹配的字符串中提取附件信息
   */
  private parseAttachment(match: string, vaultSystemPath: string, notePath: string): Attachment | null {
    let attSourcePath: string | undefined;
    let alt: string | undefined;

    if (match.startsWith("![[") && match.endsWith("]]")) {
      attSourcePath = match.slice(3, -2).split("|")[0];
    } else {
      const markdown = /^!\[[^\]]*\]\((.*)\)$/.exec(match);
      attSourcePath = markdown?.[1]?.replace(/^<|>$/g, "");
      alt = match.match(/^!\[([^\]]*)\]/)?.[1];
    }

    if (!attSourcePath) return null;

    // 确保正确解码 URI 编码的路径；非法 % 序列（如文件名含 %）时保留原串
    let decodedPath: string;
    try {
      decodedPath = decodeURI(attSourcePath);
    } catch {
      decodedPath = attSourcePath;
    }
    const parsedName = parse(normalizePath(decodedPath));

    const files = this.app.vault.getFiles();
    const resolved = this.app.metadataCache?.getFirstLinkpathDest(decodedPath, notePath);
    const exactMatch = files.find((file) =>
      file.path.toLowerCase() === normalizePath(decodedPath).toLowerCase()
    );
    const sameNames = files.filter((file) =>
      file.name.toLowerCase() === (parsedName.name + parsedName.ext).toLowerCase()
    );
    // An ambiguous basename must never silently upload another folder's file.
    const searchFile = resolved ?? exactMatch ?? (sameNames.length === 1 ? sameNames[0] : undefined);

    return {
      source: match,
      alt: alt ?? file.name,
      basename: parsedName.base,
      name: parsedName.name,
      ext: parsedName.ext,
      existenceState: attSourcePath.startsWith("http")
        ? "network"
        : searchFile
          ? "local"
          : "missing",
      inVaultPath: searchFile ? searchFile.path : normalizePath(decodedPath),
      inSystemPath: searchFile
        ? `${vaultSystemPath}/${searchFile.path}`
        : normalizePath(decodedPath),
    };
  }
}
