import { ImageReferenceTracker } from "../attachments/imageReferenceTracker";
import { buildRemoteImageReplacements, type TextChange } from "../attachments/imageRewriter";
import { toMarkdownUrl } from "../attachments/imageRewriter";
import {
  collectRemoteImageReferences,
  type RemoteImageDocument,
  type RemoteImageReference,
} from "../attachments/markdown";
import {
  RemoteImageDownloadError,
  type DownloadedImage,
  type RemoteImageDownloadFailureCode,
} from "./imageDownloader";
import { UploadCancelledError } from "./uploader";
import type { UploadResult } from "./uploader";

export const MAX_UNIQUE_REMOTE_IMAGES = 100;
export const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REMOTE_IMAGE_BATCH_BYTES = 200 * 1024 * 1024;
export const REMOTE_IMAGE_DOWNLOAD_CONCURRENCY = 3;
const MAX_SESSION_OUTPUT_URLS = 2_000;

export type RemoteImageScopeKind = "note" | "paste";

export interface RemoteImageScope {
  kind: RemoteImageScopeKind;
  tracker?: ImageReferenceTracker;
  start?: number;
  end?: number;
  anchorText?: string;
}

export function isAllowedRemoteImageFormat(
  formats: ReadonlySet<string>,
  extension: string,
): boolean {
  const normalized = extension.toLowerCase().replace(/^\./, "");
  const candidates =
    normalized === "jpg" || normalized === "jpeg" ? [".jpg", ".jpeg"] : [`.${normalized}`];
  return candidates.some((candidate) => formats.has(candidate));
}

export interface RemoteImageTransferSettings {
  uploadFileFormat: Set<string>;
  prefixes: readonly RemoteHostPrefix[];
  maxUniqueUrls?: number;
  maxImageBytes?: number;
  batchBytes?: number;
  downloadConcurrency?: number;
  downloadTimeoutMs?: number;
}

export interface TransferDocumentSnapshot {
  content: string;
  live: boolean;
}

export interface TransferDocumentAccess {
  read(): Promise<TransferDocumentSnapshot | null>;
  apply(content: string, changes: readonly TextChange[]): Promise<boolean>;
}

export interface TransferDownloader {
  download(
    url: string,
    options: {
      signal?: AbortSignal;
      maxBytes?: number;
      timeoutMs?: number;
      budget?: { used: number; limit: number };
    },
  ): Promise<DownloadedImage>;
  release(path: string): Promise<void>;
}

export interface ImageTransferDeps {
  document: TransferDocumentAccess;
  downloader: TransferDownloader;
  upload: (path: string) => Promise<UploadResult>;
  preserveReceipt: (url: string, sourcePath: string, filename: string) => Promise<void>;
  sessionOutputs: Set<string>;
}

export interface TransferProgress {
  total: number;
  completed: number;
  phase: "downloading" | "uploading" | "applying";
}

export interface TransferSummary {
  totalReferences: number;
  uniqueUrls: number;
  skipped: number;
  succeeded: number;
  failed: number;
  notApplied: number;
  cancelled: boolean;
  limitExceeded: boolean;
  errors: Array<{ code: string; url: string }>;
}

export interface TransferInput {
  sourcePath: string;
  scope: RemoteImageScope;
  settings: RemoteImageTransferSettings;
  signal: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

interface UploadOutcome {
  newUrl?: string;
  error?: string;
}

interface DownloadOutcome {
  file?: DownloadedImage;
  error?: RemoteImageDownloadFailureCode | "format-not-allowed";
}

export function emptyTransferSummary(): TransferSummary {
  return {
    totalReferences: 0,
    uniqueUrls: 0,
    skipped: 0,
    succeeded: 0,
    failed: 0,
    notApplied: 0,
    cancelled: false,
    limitExceeded: false,
    errors: [],
  };
}

function referencesInScope(
  document: RemoteImageDocument,
  scope: RemoteImageScope,
): RemoteImageReference[] {
  if (scope.kind === "note") return document.references;
  if (scope.start === undefined || scope.end === undefined) return [];
  return document.references.filter(
    (reference) => reference.start >= scope.start! && reference.end <= scope.end!,
  );
}

export function captureRemoteImageReferences(
  content: string,
  scope: RemoteImageScope,
): ImageReferenceTracker {
  const document = collectRemoteImageReferences(content);
  // Legacy callers without a transaction tracker may only use exact source ranges.
  const matchesAnchor =
    !scope.anchorText ||
    (scope.start !== undefined &&
      scope.end !== undefined &&
      content.slice(scope.start, scope.end) === scope.anchorText);
  return new ImageReferenceTracker(
    content,
    matchesAnchor ? referencesInScope(document, scope) : [],
  );
}

function imageNameFromUrl(url: string): string {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const name = pathname.split("/").filter(Boolean).at(-1) ?? "";
    return name && name.length <= 200 ? name : "remote-image";
  } catch {
    return "remote-image";
  }
}

function classifyError(error: unknown): RemoteImageDownloadFailureCode {
  return error instanceof RemoteImageDownloadError ? error.code : "network";
}

export function remoteImageSessionKey(url: string): string {
  const formatted = toMarkdownUrl(url);
  return formatted.startsWith("<") && formatted.endsWith(">") ? formatted.slice(1, -1) : formatted;
}

export function rememberSessionOutput(outputs: Set<string>, url: string): void {
  outputs.add(remoteImageSessionKey(url));
  if (outputs.size <= MAX_SESSION_OUTPUT_URLS) return;
  const oldest = outputs.values().next().value;
  if (oldest !== undefined) outputs.delete(oldest);
}

export class ImageTransferService {
  private readonly deps: ImageTransferDeps;

  constructor(deps: ImageTransferDeps) {
    this.deps = deps;
  }

  private async receipt(url: string, sourcePath: string): Promise<void> {
    await this.deps.preserveReceipt(url, sourcePath, imageNameFromUrl(url)).catch(() => undefined);
  }

  async transfer(input: TransferInput): Promise<TransferSummary> {
    const summary = emptyTransferSummary();
    const { settings, signal, scope } = input;
    if (signal.aborted) {
      summary.cancelled = true;
      return summary;
    }

    let initial: TransferDocumentSnapshot | null;
    try {
      initial = await this.deps.document.read();
    } catch {
      return summary;
    }
    if (!initial) return summary;
    const snapshot = initial.content;
    const tracker = scope.tracker ?? captureRemoteImageReferences(snapshot, scope);
    const scoped = tracker.references(snapshot);
    summary.totalReferences = scoped.length;

    const candidates: RemoteImageReference[] = [];
    const skippedUrls = new Set<string>();
    for (const reference of scoped) {
      if (
        isOwnRemoteImageUrl(reference.url, settings.prefixes) ||
        this.deps.sessionOutputs.has(remoteImageSessionKey(reference.url))
      ) {
        skippedUrls.add(reference.url);
        continue;
      }
      candidates.push(reference);
    }
    summary.skipped = skippedUrls.size;

    const uniqueUrls = new Map<string, RemoteImageReference>();
    for (const reference of candidates) {
      if (!uniqueUrls.has(reference.url)) uniqueUrls.set(reference.url, reference);
    }
    summary.uniqueUrls = uniqueUrls.size;
    const maxUnique = settings.maxUniqueUrls ?? MAX_UNIQUE_REMOTE_IMAGES;
    if (uniqueUrls.size > maxUnique) {
      summary.limitExceeded = true;
      return summary;
    }
    if (!uniqueUrls.size) return summary;

    const outcomes = new Map<string, DownloadOutcome>();
    const queue = [...uniqueUrls.keys()];
    const budget = {
      used: 0,
      limit: settings.batchBytes ?? MAX_REMOTE_IMAGE_BATCH_BYTES,
    };
    let completed = 0;
    const concurrency = Math.max(
      1,
      Math.min(settings.downloadConcurrency ?? REMOTE_IMAGE_DOWNLOAD_CONCURRENCY, queue.length),
    );
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        if (signal.aborted) return;
        const url = queue.shift();
        if (!url) return;
        try {
          const file = await this.deps.downloader.download(url, {
            signal,
            maxBytes: settings.maxImageBytes ?? MAX_REMOTE_IMAGE_BYTES,
            timeoutMs: settings.downloadTimeoutMs,
            budget,
          });
          outcomes.set(url, { file });
        } catch (error) {
          outcomes.set(url, { error: classifyError(error) });
        }
        completed += 1;
        input.onProgress?.({
          total: uniqueUrls.size,
          completed,
          phase: "downloading",
        });
      }
    });
    await Promise.all(workers);

    if (signal.aborted) {
      for (const outcome of outcomes.values()) {
        if (outcome.file) await this.deps.downloader.release(outcome.file.path);
      }
      summary.cancelled = true;
      return summary;
    }

    const results = new Map<string, UploadOutcome>();
    const released = new Set<string>();
    let uploadedCount = 0;
    for (const [url, outcome] of outcomes) {
      if (signal.aborted) break;
      if (!outcome.file) continue;
      released.add(outcome.file.path);
      const extension = `.${outcome.file.extension}`;
      if (!isAllowedRemoteImageFormat(settings.uploadFileFormat, extension)) {
        summary.skipped += 1;
        outcomes.set(url, { error: "format-not-allowed" });
        await this.deps.downloader.release(outcome.file.path);
        continue;
      }
      let upload: UploadResult;
      try {
        upload = await this.deps.upload(outcome.file.path);
      } catch (error) {
        if (signal.aborted && error instanceof UploadCancelledError) {
          await this.deps.downloader.release(outcome.file.path);
          break;
        }
        upload = { success: false, errorMessage: (error as Error).message };
      }
      await this.deps.downloader.release(outcome.file.path);
      if (upload.success && upload.url) {
        results.set(url, { newUrl: upload.url });
        rememberSessionOutput(this.deps.sessionOutputs, upload.url);
      } else {
        results.set(url, { error: "upload-failed" });
      }
      uploadedCount += 1;
      input.onProgress?.({
        total: uniqueUrls.size,
        completed: uploadedCount,
        phase: "uploading",
      });
    }

    for (const [url, outcome] of outcomes) {
      if (outcome.file && !released.has(outcome.file.path)) {
        await this.deps.downloader.release(outcome.file.path);
      }
      if (outcome.error && outcome.error !== "aborted") {
        if (outcome.error === "format-not-allowed") continue;
        summary.failed += 1;
        summary.errors.push({ code: outcome.error, url });
      }
    }
    for (const [url, result] of results) {
      if (!result.newUrl) {
        summary.failed += 1;
        summary.errors.push({ code: result.error ?? "upload-failed", url });
      }
    }

    const successes = [...results].filter((entry): entry is [string, { newUrl: string }] =>
      Boolean(entry[1].newUrl),
    );

    if (signal.aborted) {
      for (const [, result] of successes) await this.receipt(result.newUrl, input.sourcePath);
      summary.cancelled = true;
      summary.notApplied = successes.length;
      return summary;
    }
    if (!successes.length) return summary;

    input.onProgress?.({
      total: uniqueUrls.size,
      completed: uniqueUrls.size,
      phase: "applying",
    });

    const failToApply = async () => {
      for (const [, result] of successes) await this.receipt(result.newUrl, input.sourcePath);
      summary.notApplied = successes.length;
      return summary;
    };

    let latest: TransferDocumentSnapshot | null;
    try {
      latest = await this.deps.document.read();
    } catch {
      return await failToApply();
    }
    if (!latest) return await failToApply();
    if (!latest.live && latest.content !== snapshot) return await failToApply();

    if (signal.aborted) {
      summary.cancelled = true;
      return await failToApply();
    }
    const remaining = tracker.references(latest.content);
    const contains = (start: number, end: number) =>
      remaining.some((reference) => reference.start === start && reference.end === end);

    const currentDocument = collectRemoteImageReferences(latest.content);
    const replacements = new Map<string, string>();
    for (const [url, result] of successes) replacements.set(url, result.newUrl);
    const plan = buildRemoteImageReplacements(
      latest.content,
      currentDocument,
      replacements,
      contains,
    );
    if (!plan || !plan.changes.length) return await failToApply();

    let applied = false;
    try {
      applied = await this.deps.document.apply(latest.content, plan.changes);
    } catch {
      applied = false;
    }
    if (!applied) return await failToApply();

    for (const [url, result] of successes) {
      if (plan.appliedUrls.has(url)) {
        summary.succeeded += 1;
      } else {
        summary.notApplied += 1;
        await this.receipt(result.newUrl, input.sourcePath);
      }
    }
    return summary;
  }
}

export interface RemoteHostPrefix {
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
  pathname: string;
  text: string;
}

export function parseRemoteHostPrefix(value: string): RemoteHostPrefix | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;

  const pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port,
    pathname,
    text: `${parsed.protocol}//${parsed.host}${pathname}`,
  };
}

export function compileRemoteHostPrefixes(values: readonly string[]): RemoteHostPrefix[] {
  const seen = new Set<string>();
  const prefixes: RemoteHostPrefix[] = [];
  for (const value of values) {
    const parsed = parseRemoteHostPrefix(value);
    if (!parsed || seen.has(parsed.text)) continue;
    seen.add(parsed.text);
    prefixes.push(parsed);
  }
  return prefixes;
}

/**
 * Protocol, exact host, effective port and a path-directory boundary must all
 * match. Query strings and fragments in the image URL are preserved separately
 * and never relaxed here.
 */
export function isUrlCoveredByPrefix(url: URL, prefix: RemoteHostPrefix): boolean {
  if (url.protocol !== prefix.protocol) return false;
  if (url.hostname.toLowerCase() !== prefix.hostname) return false;
  if (url.port !== prefix.port) return false;
  return prefix.pathname === "/" || url.pathname.startsWith(prefix.pathname);
}

export function isOwnRemoteImageUrl(url: string, prefixes: readonly RemoteHostPrefix[]): boolean {
  if (!prefixes.length) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return prefixes.some((prefix) => isUrlCoveredByPrefix(parsed, prefix));
}
