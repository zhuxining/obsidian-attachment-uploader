import { parse } from "node:path";

import {
  normalizePath,
  type DataAdapter,
  type FileSystemAdapter,
  type TFile,
  type MetadataCache,
} from "obsidian";

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

/** Mask non-rendered examples without changing offsets in the original text. */
function maskExamples(content: string): string {
  const ranges: Array<[number, number]> = [];
  const fences = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
  let fence: RegExpExecArray | null;
  while ((fence = fences.exec(content))) {
    const delimiter = fence[1]!;
    const closing = new RegExp(
      `^ {0,3}${delimiter[0]}{${delimiter.length},}[\\t ]*(?:\\r?$)`,
      "gm",
    );
    closing.lastIndex = fences.lastIndex;
    const end = closing.exec(content);
    const offset = end ? closing.lastIndex : content.length;
    ranges.push([fence.index, offset]);
    fences.lastIndex = offset;
  }
  let masked = content;
  for (const [start, end] of ranges.reverse()) {
    masked =
      masked.slice(0, start) + masked.slice(start, end).replace(/[^\n]/g, " ") + masked.slice(end);
  }
  const tokens = /<!--|`+/g;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(masked))) {
    let end = -1;
    if (token[0] === "<!--") {
      const closing = masked.indexOf("-->", tokens.lastIndex);
      end = closing < 0 ? masked.length : closing + 3;
    } else {
      const ticks = /`+/g;
      ticks.lastIndex = tokens.lastIndex;
      let closing: RegExpExecArray | null;
      while ((closing = ticks.exec(masked))) {
        if (closing[0] === token[0]) {
          end = ticks.lastIndex;
          break;
        }
      }
    }
    if (end < 0) continue;
    masked =
      masked.slice(0, token.index) +
      masked.slice(token.index, end).replace(/[^\n]/g, " ") +
      masked.slice(end);
    tokens.lastIndex = end;
  }
  return masked;
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
    const regex =
      /!\[\[([^\]]+)\]\]|!\[(?:\\.|[^\]\\\n])*\]\((<[^>\n]+>|(?:\\.|[^()\\\n]|\([^()]*\))+)\)/g;
    const matches = Array.from(maskExamples(content).matchAll(regex));
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
        const start = match.index;
        const attachment = this.parseAttachment(
          content.slice(start, start + match[0].length),
          vaultSystemPath,
          markdownFile.file?.path ?? "",
          paths,
          names,
        );
        return attachment ? { ...attachment, start, end: start + match[0].length } : null;
      })
      .filter((attachment: Attachment | null): attachment is Attachment => attachment !== null);
  }

  /**
   * 解析单个附件
   * 从匹配的字符串中提取附件信息
   */
  private parseAttachment(
    match: string,
    vaultSystemPath: string,
    notePath: string,
    paths: Map<string, TFile>,
    names: Map<string, TFile | null>,
  ): Omit<Attachment, "start" | "end"> | null {
    let attSourcePath: string | undefined;
    let alt: string | undefined;

    if (match.startsWith("![[") && match.endsWith("]]")) {
      attSourcePath = match.slice(3, -2).split("|")[0];
    } else {
      const markdown = /^!\[((?:\\.|[^\]\\])*)\]\((.*)\)$/.exec(match);
      attSourcePath = markdown?.[2]?.replace(/^<|>$/g, "");
      alt = markdown?.[1];
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

    const isNetwork = /^https?:\/\//i.test(attSourcePath);
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
