import { parse } from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";
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

interface ImageMatch {
  start: number;
  end: number;
  path: string;
  alt?: string;
}

const WIKI_EMBED = /!\[\[([^\]\r\n]+)\]\]/g;
const HTML_TAG = /<\s*(\/?)\s*([a-z][\w:-]*)\b[^>]*>/gi;
const VOID_HTML_TAG = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

/** mdast positions use UTF-16 offsets, just like editor slices and replacements. */
function findImages(content: string): ImageMatch[] {
  const tree = fromMarkdown(content);
  type Node = (typeof tree.children)[number];
  const definitions = new Map<string, string>();
  const images: Array<Extract<Node, { type: "image" | "imageReference" }>> = [];
  const excluded: Array<[number, number]> = [];
  const htmlRanges: Array<[number, number]> = [];
  const htmlStack: Array<{ tag: string; start: number }> = [];

  const visit = (node: Node | typeof tree): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;

    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    if (
      node.type === "code" ||
      node.type === "inlineCode" ||
      node.type === "html" ||
      node.type === "definition" ||
      node.type === "image" ||
      node.type === "imageReference"
    ) {
      excluded.push([start, end]);
      if (node.type === "html") {
        // Inline HTML is split into opening/closing nodes with Markdown between them.
        for (const tag of node.value.matchAll(HTML_TAG)) {
          const name = tag[2]!.toLowerCase();
          if (tag[1]) {
            const index = htmlStack.findLastIndex((open) => open.tag === name);
            if (index >= 0) {
              const range: [number, number] = [htmlStack[index]!.start, end];
              excluded.push(range);
              htmlRanges.push(range);
              htmlStack.splice(index);
            }
          } else if (!VOID_HTML_TAG.test(name) && !tag[0].endsWith("/>")) {
            htmlStack.push({ tag: name, start });
          }
        }
      }
      return;
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(tree);

  const matches: ImageMatch[] = [];
  for (const image of images) {
    const path = image.type === "image" ? image.url : definitions.get(image.identifier);
    const start = image.position!.start.offset!;
    const end = image.position!.end.offset!;
    // Raw HTML contents must also exclude standard Markdown images.
    const inHtml = htmlRanges.some(([from, to]) => from < start && to > end);
    if (path && !inHtml) matches.push({ start, end, path, alt: image.alt ?? "" });
  }

  // Merge exclusions once so Wiki scanning stays linear after sorting.
  excluded.sort((a, b) => a[0] - b[0]);
  const ranges: Array<[number, number]> = [];
  for (const range of excluded) {
    const last = ranges.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([...range]);
  }
  let rangeIndex = 0;
  for (const match of content.matchAll(WIKI_EMBED)) {
    const start = match.index;
    const end = start + match[0].length;
    while (ranges[rangeIndex] && ranges[rangeIndex]![1] <= start) rangeIndex++;
    const range = ranges[rangeIndex];
    if (range && range[0] < end) continue;
    let backslashes = 0;
    for (let index = start - 1; index >= 0 && content[index] === "\\"; index--) backslashes++;
    if (backslashes % 2 === 0) matches.push({ start, end, path: match[1]!.split("|")[0]! });
  }
  return matches.sort((a, b) => a.start - b.start);
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
