import { parse } from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";
import { parse as parseMarkdown, postprocess, preprocess } from "micromark";
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

export interface ImageDefinitionToken {
  identifier: string;
  start: number;
  end: number;
  targetStart: number;
  targetEnd: number;
  url: string;
  uses: Array<{ kind: "image" | "link"; start: number; end: number }>;
}

export interface RemoteImageReference {
  kind: "inline" | "reference";
  start: number;
  end: number;
  targetStart: number;
  targetEnd: number;
  url: string;
  alt: string;
  identifier: string | null;
  referenceStart: number | null;
  referenceEnd: number | null;
  definition: ImageDefinitionToken | null;
}

export interface RemoteImageDocument {
  references: RemoteImageReference[];
  definitions: ImageDefinitionToken[];
  /** All resolved standard Markdown images, including local destinations. */
  imageCount: number;
  /** Reference images whose definition is not in the parsed fragment/note. */
  hasUnresolvedReferences: boolean;
}

interface ImageMatch {
  start: number;
  end: number;
  path: string;
  alt?: string;
}

interface RawImageNode {
  kind: "inline" | "reference";
  start: number;
  end: number;
  url: string | null;
  identifier: string | null;
  alt: string;
}

interface RawDefinitionNode {
  identifier: string;
  start: number;
  end: number;
  url: string;
}

interface RawLinkReferenceNode {
  identifier: string;
  start: number;
  end: number;
}

interface ImageStructure {
  images: RawImageNode[];
  definitions: RawDefinitionNode[];
  linkReferences: RawLinkReferenceNode[];
  excludedRanges: Array<[number, number]>;
  htmlRanges: Array<[number, number]>;
}

interface TokenRanges {
  inlineTargets: Map<number, [number, number]>;
  referenceRanges: Map<number, [number, number]>;
  definitionTargets: Map<number, [number, number]>;
}

const WIKI_EMBED = /!\[\[([^\]\r\n]+)\]\]/g;
const HTML_TAG = /<\s*(\/?)\s*([a-z][\w:-]*)\b[^>]*>/gi;
const VOID_HTML_TAG = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
const REMOTE_IMAGE_URL = /^https?:\/\//i;
// Gate only: a reference image can resolve against a definition outside the
// pasted fragment, so mdast may parse the fragment as plain text.
const REFERENCE_IMAGE_SYNTAX = /!\[(?!\[)(?:\\.|[^\]\r\n])*\]\[(?:\\.|[^\]\r\n])*\]/;
const SHORTCUT_IMAGE_SYNTAX = /!\[(?!\[)(?:\\.|[^\]\r\n])+\](?![([])/;

/**
 * mdast positions identify image nodes but not the destination substring inside
 * an inline token. micromark exposes the exact `resourceDestinationString` /
 * `definitionDestinationString` ranges used by the rewriter.
 */
function collectTokenRanges(content: string): TokenRanges {
  const events = postprocess(
    parseMarkdown()
      .document()
      .write(preprocess()(content, "utf8", true)),
  );
  const inlineTargets = new Map<number, [number, number]>();
  const referenceRanges = new Map<number, [number, number]>();
  const definitionTargets = new Map<number, [number, number]>();
  let imageStart: number | null = null;
  let definitionStart: number | null = null;

  for (const [kind, token] of events) {
    const start = token.start.offset;
    const end = token.end.offset;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (kind === "enter" && token.type === "image") {
      imageStart = start;
    } else if (kind === "exit" && token.type === "image") {
      imageStart = null;
    } else if (kind === "enter" && token.type === "definition") {
      definitionStart = start;
    } else if (kind === "exit" && token.type === "definition") {
      definitionStart = null;
    } else if (
      kind === "enter" &&
      token.type === "resourceDestinationString" &&
      imageStart !== null
    ) {
      inlineTargets.set(imageStart, [start, end]);
    } else if (kind === "enter" && token.type === "reference" && imageStart !== null) {
      referenceRanges.set(imageStart, [start, end]);
    } else if (
      kind === "enter" &&
      token.type === "definitionDestinationString" &&
      definitionStart !== null
    ) {
      definitionTargets.set(definitionStart, [start, end]);
    }
  }
  return { inlineTargets, referenceRanges, definitionTargets };
}

function parseImageStructure(content: string): ImageStructure {
  const tree = fromMarkdown(content);
  type Node = (typeof tree.children)[number];
  const images: RawImageNode[] = [];
  const definitions: RawDefinitionNode[] = [];
  const linkReferences: RawLinkReferenceNode[] = [];
  const excluded: Array<[number, number]> = [];
  const htmlRanges: Array<[number, number]> = [];
  const htmlStack: Array<{ tag: string; start: number }> = [];

  const visit = (node: Node | typeof tree): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;

    if (node.type === "definition") {
      definitions.push({ identifier: node.identifier, start, end, url: node.url });
    }
    if (node.type === "image") {
      images.push({
        kind: "inline",
        start,
        end,
        url: node.url,
        identifier: null,
        alt: node.alt ?? "",
      });
    } else if (node.type === "imageReference") {
      images.push({
        kind: "reference",
        start,
        end,
        url: null,
        identifier: node.identifier,
        alt: node.alt ?? "",
      });
    } else if (node.type === "linkReference") {
      linkReferences.push({ identifier: node.identifier, start, end });
    }

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

  excluded.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of excluded) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return { images, definitions, linkReferences, excludedRanges: merged, htmlRanges };
}

function isInsideHtml(htmlRanges: Array<[number, number]>, start: number, end: number): boolean {
  return htmlRanges.some(([from, to]) => from < start && to > end);
}

/**
 * Parse standard Markdown images with definition sharing information. The same
 * pass powers the legacy local matcher, so both paths agree on token offsets.
 */
function analyzeImages(content: string): {
  images: Array<{ start: number; end: number; path: string; alt: string }>;
  references: RemoteImageReference[];
  definitions: ImageDefinitionToken[];
  imageCount: number;
  hasUnresolvedReferences: boolean;
  excludedRanges: Array<[number, number]>;
} {
  const structure = parseImageStructure(content);
  const tokenRanges = collectTokenRanges(content);
  const definitionsByIdentifier = new Map<string, ImageDefinitionToken>();
  for (const definition of structure.definitions) {
    if (definitionsByIdentifier.has(definition.identifier)) continue;
    const target = tokenRanges.definitionTargets.get(definition.start);
    definitionsByIdentifier.set(definition.identifier, {
      identifier: definition.identifier,
      start: definition.start,
      end: definition.end,
      targetStart: target?.[0] ?? -1,
      targetEnd: target?.[1] ?? -1,
      url: definition.url,
      uses: [],
    });
  }

  const images: Array<{ start: number; end: number; path: string; alt: string }> = [];
  const references: RemoteImageReference[] = [];
  let hasUnresolvedReferences = false;

  for (const image of structure.images) {
    if (isInsideHtml(structure.htmlRanges, image.start, image.end)) continue;
    if (image.kind === "inline") {
      const target = tokenRanges.inlineTargets.get(image.start);
      images.push({ start: image.start, end: image.end, path: image.url!, alt: image.alt });
      if (image.url && REMOTE_IMAGE_URL.test(image.url) && target) {
        references.push({
          kind: "inline",
          start: image.start,
          end: image.end,
          targetStart: target[0],
          targetEnd: target[1],
          url: image.url,
          alt: image.alt,
          identifier: null,
          referenceStart: null,
          referenceEnd: null,
          definition: null,
        });
      }
      continue;
    }

    const identifier = image.identifier;
    const definition = identifier ? definitionsByIdentifier.get(identifier) : undefined;
    if (!definition) {
      hasUnresolvedReferences = true;
      continue;
    }
    definition.uses.push({ kind: "image", start: image.start, end: image.end });
    images.push({ start: image.start, end: image.end, path: definition.url, alt: image.alt });
    if (!REMOTE_IMAGE_URL.test(definition.url)) continue;
    if (definition.targetStart < 0) continue;
    const reference = tokenRanges.referenceRanges.get(image.start) ?? null;
    references.push({
      kind: "reference",
      start: image.start,
      end: image.end,
      targetStart: definition.targetStart,
      targetEnd: definition.targetEnd,
      url: definition.url,
      alt: image.alt,
      identifier: definition.identifier,
      referenceStart: reference?.[0] ?? null,
      referenceEnd: reference?.[1] ?? null,
      definition,
    });
  }

  for (const link of structure.linkReferences) {
    definitionsByIdentifier.get(link.identifier)?.uses.push({
      kind: "link",
      start: link.start,
      end: link.end,
    });
  }

  return {
    images,
    references: references.sort((a, b) => a.start - b.start),
    definitions: [...definitionsByIdentifier.values()],
    imageCount: images.length,
    hasUnresolvedReferences,
    excludedRanges: structure.excludedRanges,
  };
}

/** mdast positions use UTF-16 offsets, just like editor slices and replacements. */
function findImages(content: string): ImageMatch[] {
  const analysis = analyzeImages(content);
  const matches: ImageMatch[] = analysis.images.map((image) => ({
    start: image.start,
    end: image.end,
    path: image.path,
    alt: image.alt,
  }));

  const ranges = analysis.excludedRanges;
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

/** Remote image references in source order, with exact replacement ranges. */
export function collectRemoteImageReferences(content: string): RemoteImageDocument {
  const analysis = analyzeImages(content);
  return {
    references: analysis.references,
    definitions: analysis.definitions,
    imageCount: analysis.imageCount,
    hasUnresolvedReferences: analysis.hasUnresolvedReferences,
  };
}

export function hasPotentialImageReferenceSyntax(content: string): boolean {
  return REFERENCE_IMAGE_SYNTAX.test(content) || SHORTCUT_IMAGE_SYNTAX.test(content);
}

export function findRemoteImageAtOffset(
  content: string,
  offset: number,
): RemoteImageReference | null {
  const { references } = collectRemoteImageReferences(content);
  return (
    references.find((reference) => reference.start <= offset && offset < reference.end) ?? null
  );
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
