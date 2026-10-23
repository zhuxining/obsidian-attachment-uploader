import type {
  ImageDefinitionToken,
  RemoteImageDocument,
  RemoteImageReference,
} from "../attachmentMatcher";
import { toMarkdownUrl } from "./url";

export interface TextChange {
  start: number;
  end: number;
  text: string;
}

export interface RemoteImageReplacementPlan {
  changes: TextChange[];
  appliedUrls: Set<string>;
}

export interface ReplacementOptions {
  definitionIdPrefix?: string;
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
  _options: ReplacementOptions = {},
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
    const title = definition.title === null
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
