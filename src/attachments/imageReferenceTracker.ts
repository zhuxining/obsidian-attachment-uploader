import type { ChangeDesc } from "@codemirror/state";

import { collectRemoteImageReferences, type RemoteImageReference } from "./markdown";

interface TrackedRange {
  start: number;
  end: number;
}

interface TrackedImage {
  image: TrackedRange;
  definition: TrackedRange | null;
  url: string;
  source: string;
  valid: boolean;
}

/** Only editor transactions may move identities; matching text cannot restore one. */
export class ImageReferenceTracker {
  private content: string;
  private attached = true;
  private readonly images: TrackedImage[];

  constructor(content: string, references: readonly RemoteImageReference[]) {
    this.content = content;
    this.images = references.map((reference) => ({
      image: { start: reference.start, end: reference.end },
      definition: reference.definition
        ? { start: reference.definition.start, end: reference.definition.end }
        : null,
      url: reference.url,
      source: content.slice(reference.start, reference.end),
      valid: true,
    }));
  }

  detach(): void {
    this.attached = false;
  }

  update(before: string, after: string, changes: ChangeDesc): void {
    if (!this.attached) return;
    if (before !== this.content) {
      this.detach();
      return;
    }
    for (const entry of this.images) {
      if (!entry.valid) continue;
      for (const range of [entry.image, entry.definition]) {
        if (!range) continue;
        changes.iterChangedRanges((from, to) => {
          // Inserts at token boundaries are revalidated by the parser below.
          if (from < range.end && to > range.start) entry.valid = false;
          if (from === to && from > range.start && from < range.end) entry.valid = false;
        });
        range.start = changes.mapPos(range.start, 1);
        range.end = changes.mapPos(range.end, -1);
      }
    }
    this.content = after;
    // Changes outside the token (e.g. adding a code fence) may change its meaning.
    this.validate(after);
  }

  private validate(content: string): RemoteImageReference[] {
    if (!this.attached || content !== this.content) return [];
    const current = collectRemoteImageReferences(content);
    const accepted: RemoteImageReference[] = [];
    for (const entry of this.images) {
      if (!entry.valid) continue;
      const match = current.references.find(
        (reference) =>
          reference.start === entry.image.start &&
          reference.end === entry.image.end &&
          reference.url === entry.url &&
          content.slice(reference.start, reference.end) === entry.source &&
          (entry.definition
            ? reference.definition?.start === entry.definition.start &&
              reference.definition?.end === entry.definition.end
            : reference.definition === null),
      );
      if (match) accepted.push(match);
      else entry.valid = false;
    }
    return accepted;
  }

  references(content: string): RemoteImageReference[] {
    if (content !== this.content) this.detach();
    return this.validate(content);
  }
}
