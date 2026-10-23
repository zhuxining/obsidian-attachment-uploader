import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export type RemoteImageDownloadFailureCode =
  | "invalid-url"
  | "http-status"
  | "too-large"
  | "batch-limit"
  | "not-an-image"
  | "timeout"
  | "network"
  | "aborted"
  | "io";

export class RemoteImageDownloadError extends Error {
  readonly code: RemoteImageDownloadFailureCode;
  readonly status: number | undefined;

  constructor(code: RemoteImageDownloadFailureCode, message?: string, status?: number) {
    super(message ?? code);
    this.name = "RemoteImageDownloadError";
    this.code = code;
    this.status = status;
  }
}

export interface DownloadBudget {
  used: number;
  limit: number;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  budget?: DownloadBudget;
}

export interface DownloadedImage {
  path: string;
  extension: string;
  bytes: number;
}

export interface RemoteImageDownloaderOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

interface RequestContext {
  signal: AbortSignal;
  budget?: DownloadBudget;
  maxBytes: number;
  maxRedirects: number;
}

interface ImageType {
  extension: string;
  mime: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const SNIFF_BYTES = 4096;
const TEMP_PREFIX = "obsidian-attachment-uploader-remote-";
const USER_AGENT = "Obsidian-Attachment-Uploader/1.3";

function tooLarge(): RemoteImageDownloadError {
  return new RemoteImageDownloadError("too-large", "Remote image exceeds the size limit");
}

function assertBudget(budget: DownloadBudget | undefined, additional: number): void {
  if (!budget) return;
  if (budget.used + additional > budget.limit) {
    throw new RemoteImageDownloadError("batch-limit", "Remote image batch size limit reached");
  }
}

function assertAllowedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteImageDownloadError("invalid-url", "Invalid remote image URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteImageDownloadError("invalid-url", "Only HTTP(S) image URLs are supported");
  }
  if (url.username || url.password) {
    throw new RemoteImageDownloadError("invalid-url", "URL credentials are not allowed");
  }
  return url;
}

function responseDecoder(response: IncomingMessage): Transform | null {
  const encoding = String(response.headers["content-encoding"] ?? "")
    .split(",")[0]!
    .trim()
    .toLowerCase();
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return null;
  }
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

export function sniffImageType(buffer: Buffer, _contentType: string): ImageType | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: "png", mime: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", mime: "image/jpeg" };
  }
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") {
    return { extension: "gif", mime: "image/gif" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { extension: "webp", mime: "image/webp" };
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { extension: "bmp", mime: "image/bmp" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("latin1") === "ftyp" &&
    /avif|avis/.test(buffer.subarray(8, 64).toString("latin1"))
  ) {
    return { extension: "avif", mime: "image/avif" };
  }

  const head = buffer
    .subarray(0, SNIFF_BYTES)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  const lower = head.toLowerCase();
  if (
    lower.startsWith("<!doctype html") ||
    lower.startsWith("<html") ||
    lower.startsWith("<head")
  ) {
    return null;
  }
  // An SVG document must start with its root element after the optional XML
  // prolog, comments and doctype. HTML error pages often embed <svg> logos.
  let root = head;
  for (let pass = 0; pass < 4; pass += 1) {
    const previous = root;
    root = root
      .replace(/^<\?xml[^>]*\?>/i, "")
      .replace(/^<!--[\s\S]*?-->/, "")
      .replace(/^<!doctype[^>]*>/i, "")
      .trimStart();
    if (root === previous) break;
  }
  if (/^<svg[\s>]/i.test(root)) {
    return { extension: "svg", mime: "image/svg+xml" };
  }
  return null;
}

export class RemoteImageDownloader {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private workDirectoryPromise: Promise<string> | null = null;

  constructor(options: RemoteImageDownloaderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  private async workDirectory(): Promise<string> {
    this.workDirectoryPromise ??= mkdtemp(join(tmpdir(), TEMP_PREFIX));
    return await this.workDirectoryPromise;
  }

  async download(url: string, options: DownloadOptions = {}): Promise<DownloadedImage> {
    if (options.signal?.aborted) {
      throw new RemoteImageDownloadError("aborted", "Download cancelled");
    }
    const maxBytes = options.maxBytes ?? this.maxBytes;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const context: RequestContext = {
      signal: controller.signal,
      budget: options.budget,
      maxBytes,
      maxRedirects: options.maxRedirects ?? this.maxRedirects,
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetchInto(assertAllowedUrl(url), context);
    } catch (error) {
      if (timedOut)
        throw new RemoteImageDownloadError("timeout", "Remote image download timed out");
      if (options.signal?.aborted || controller.signal.aborted) {
        throw new RemoteImageDownloadError("aborted", "Download cancelled");
      }
      if (error instanceof RemoteImageDownloadError) throw error;
      throw new RemoteImageDownloadError("network", (error as Error).message);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async fetchInto(
    url: URL,
    context: RequestContext,
    redirects = 0,
  ): Promise<DownloadedImage> {
    const response = await this.requestOnce(url, context);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400) {
      response.destroy();
      if (redirects >= context.maxRedirects) {
        throw new RemoteImageDownloadError("http-status", "Too many redirects", status);
      }
      const location = response.headers.location;
      if (!location) {
        throw new RemoteImageDownloadError("http-status", "Redirect without location", status);
      }
      const next = assertAllowedUrl(new URL(location, url).toString());
      return await this.fetchInto(next, context, redirects + 1);
    }

    if (status < 200 || status >= 300) {
      response.destroy();
      throw new RemoteImageDownloadError("http-status", `HTTP ${status}`, status);
    }

    try {
      return await this.streamToFile(response, context);
    } finally {
      response.destroy();
    }
  }

  private requestOnce(url: URL, context: RequestContext): Promise<IncomingMessage> {
    return new Promise((resolvePromise, rejectPromise) => {
      const requestFactory = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = requestFactory(
        url,
        {
          method: "GET",
          agent: false,
          signal: context.signal,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "image/*,*/*;q=0.8",
          },
        },
        (response) => {
          // The body can fail while the temp directory is being created. Pipeline
          // observes the destroyed stream; keep that early error handled too.
          response.on("error", () => undefined);
          resolvePromise(response);
        },
      );
      request.once("error", (error) => {
        rejectPromise(
          error instanceof RemoteImageDownloadError
            ? error
            : new RemoteImageDownloadError("network", (error as Error).message),
        );
      });
      request.end();
    });
  }

  private async streamToFile(
    response: IncomingMessage,
    context: RequestContext,
  ): Promise<DownloadedImage> {
    const contentType = String(response.headers["content-type"] ?? "");
    const contentLength = Number(response.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(contentLength) && contentLength > context.maxBytes) {
      response.destroy();
      throw tooLarge();
    }
    if (Number.isFinite(contentLength)) assertBudget(context.budget, contentLength);

    const directory = await this.workDirectory();
    const partPath = join(directory, `${randomUUID()}.part`);
    const output = createWriteStream(partPath, { flags: "wx", mode: 0o600 });
    const decoder = responseDecoder(response);
    const prefixChunks: Buffer[] = [];
    let prefixLength = 0;
    let written = 0;

    const inspector = new Transform({
      transform(raw: Buffer, _encoding, callback) {
        try {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          written += chunk.length;
          if (written > context.maxBytes) throw tooLarge();
          assertBudget(context.budget, chunk.length);
          if (context.budget) context.budget.used += chunk.length;
          if (prefixLength < SNIFF_BYTES) {
            const slice = chunk.subarray(0, SNIFF_BYTES - prefixLength);
            prefixChunks.push(slice);
            prefixLength += slice.length;
          }
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    try {
      // Pipeline propagates aborts and premature closes through the decoder and
      // waits for the output to close before temp-file cleanup.
      if (decoder) {
        await pipeline(response, decoder, inspector, output, { signal: context.signal });
      } else {
        await pipeline(response, inspector, output, { signal: context.signal });
      }
    } catch (error) {
      await unlink(partPath).catch(() => undefined);
      throw error;
    }

    const sniffed = sniffImageType(Buffer.concat(prefixChunks), contentType);
    if (!sniffed) {
      await unlink(partPath).catch(() => undefined);
      throw new RemoteImageDownloadError("not-an-image", "Response was not a supported image");
    }

    const finalPath = join(directory, `${randomUUID()}.${sniffed.extension}`);
    try {
      await rename(partPath, finalPath);
    } catch (error) {
      await unlink(partPath).catch(() => undefined);
      throw new RemoteImageDownloadError("io", (error as Error).message);
    }
    return { path: finalPath, extension: sniffed.extension, bytes: written };
  }

  async release(path: string): Promise<void> {
    const directory = await this.workDirectoryPromise;
    if (!directory) return;
    const expected = resolve(directory);
    const target = resolve(path);
    if (dirname(target) !== expected) return;
    await unlink(target).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    const directory = await this.workDirectoryPromise;
    this.workDirectoryPromise = null;
    if (!directory) return;
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
