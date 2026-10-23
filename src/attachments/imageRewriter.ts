import type { ImageDefinitionToken, RemoteImageDocument, RemoteImageReference } from "./markdown";

export interface TextChange {
  start: number;
  end: number;
  text: string;
}

export interface RemoteImageReplacementPlan {
  changes: TextChange[];
  appliedUrls: Set<string>;
}

/** Apply UTF-16 offset changes; ranges are relative to the unmodified content. */
export function applyTextChanges(content: string, changes: readonly TextChange[]): string {
  let result = content;
  const sorted = [...changes].sort((a, b) => b.start - a.start || b.end - a.end);
  for (const change of sorted) {
    if (change.start < 0 || change.end < change.start || change.end > content.length) {
      throw new Error("Invalid text change range");
    }
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  }
  return result;
}

function isAngleWrapped(content: string, start: number, end: number): boolean {
  return content[start - 1] === "<" && content[end] === ">";
}

function formatDestination(content: string, start: number, end: number, url: string): string {
  const markdownUrl = toMarkdownUrl(url);
  if (!isAngleWrapped(content, start, end)) return markdownUrl;
  const unwrapped =
    markdownUrl.startsWith("<") && markdownUrl.endsWith(">")
      ? markdownUrl.slice(1, -1)
      : markdownUrl;
  return unwrapped;
}

function definitionUsesOnlyInScopeImages(
  definition: ImageDefinitionToken,
  referencesByStart: Map<number, RemoteImageReference>,
  inScope: (start: number, end: number) => boolean,
): boolean {
  return definition.uses.every((use) => {
    if (use.kind !== "image") return false;
    const reference = referencesByStart.get(use.start);
    return reference !== undefined && inScope(reference.start, reference.end);
  });
}

/**
 * Build a single transaction that rewrites only the destination of in-scope
 * image references. Shared reference definitions are never modified when an
 * ordinary link or an out-of-scope image also uses them: those images become
 * inline images with the original label and title instead.
 */
export function buildRemoteImageReplacements(
  content: string,
  document: RemoteImageDocument,
  replacements: ReadonlyMap<string, string>,
  inScope: (start: number, end: number) => boolean,
): RemoteImageReplacementPlan | null {
  const changes: TextChange[] = [];
  const appliedUrls = new Set<string>();
  const referencesByStart = new Map(
    document.references.map((reference) => [reference.start, reference]),
  );
  const rewrittenDefinitions = new Set<string>();

  for (const reference of document.references) {
    if (!inScope(reference.start, reference.end)) continue;
    const newUrl = replacements.get(reference.url);
    if (!newUrl) continue;

    if (reference.kind === "inline") {
      if (reference.targetStart < 0) continue;
      changes.push({
        start: reference.targetStart,
        end: reference.targetEnd,
        text: formatDestination(content, reference.targetStart, reference.targetEnd, newUrl),
      });
      appliedUrls.add(reference.url);
      continue;
    }

    const definition = reference.definition;
    if (!definition || definition.targetStart < 0) continue;

    if (rewrittenDefinitions.has(definition.identifier)) {
      appliedUrls.add(reference.url);
      continue;
    }

    const canRewriteDefinition = definitionUsesOnlyInScopeImages(
      definition,
      referencesByStart,
      inScope,
    );

    if (canRewriteDefinition) {
      changes.push({
        start: definition.targetStart,
        end: definition.targetEnd,
        text: formatDestination(content, definition.targetStart, definition.targetEnd, newUrl),
      });
      rewrittenDefinitions.add(definition.identifier);
      appliedUrls.add(reference.url);
      continue;
    }

    const label = content.slice(reference.start, reference.referenceStart ?? reference.end);
    // Serialize the parsed title so blockquote/list prefixes cannot enter the image.
    const title =
      definition.title === null
        ? ""
        : ` "${definition.title
            .replace(/&/g, "&amp;")
            .replace(/\\/g, "&#92;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\r/g, "&#13;")
            .replace(/\n/g, "&#10;")}"`;
    changes.push({
      start: reference.start,
      end: reference.end,
      text: `${label}(${toMarkdownUrl(newUrl)}${title})`,
    });
    appliedUrls.add(reference.url);
  }

  const sorted = [...changes].sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = -1;
  for (const change of sorted) {
    if (change.start < previousEnd) return null;
    if (change.end > content.length) return null;
    previousEnd = Math.max(previousEnd, change.end);
  }
  return { changes: sorted, appliedUrls };
}

/**
 * 生成 Markdown 链接可用的 URL。
 * uPic 等工具会把上传得到的 URL 再做一次百分号编码（如把 %E6 编成 %25E6），
 * 产生 %25 这种二次编码，直接访问会 404。因此要逐层解码直到不再出现 %25
 * （过度编码的标志），即可得到正确的单次编码 URL——此时绝不可再 encodeURI，
 * 否则 % 会被重新编回 %25。仅当 URL 完全未编码（不含任何 %）时，才补一次
 * encodeURI 把中文/空格等归一化为合法 URL。
 * 括号在 Markdown 裸链接里会提前截断，因此含括号时用尖括号 <...> 包裹。
 */
export function toMarkdownUrl(url: string): string {
  let value = url.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(/%25(?=[0-9a-f]{2})/gi, "%");
    if (next === value) break;
    value = next;
  }
  // Preserve existing %XX sequences when encoding remaining Unicode/whitespace.
  value = encodeURI(value).replace(/%25([0-9a-f]{2})/gi, "%$1");
  return /[()]/.test(value) ? `<${value}>` : value;
}

const IMAGE_EXTENSION_REGEX = /\.(avif|bmp|gif|jpeg|jpg|png|svg|webp)$/i;

export function formatUploadedFile(filename: string, url: string): string {
  const target = toMarkdownUrl(url);
  const label = filename.replace(/[\\[\]]/g, "\\$&");
  return IMAGE_EXTENSION_REGEX.test(filename) ? `![${label}](${target})` : `[${label}](${target})`;
}
