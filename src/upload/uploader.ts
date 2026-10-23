import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UPLOAD_TIMEOUT_MS = 20 * 60_000; // Allow slower video uploads without an unbounded process
const MAX_BUFFER_BYTES = 1024 * 1024;

/** Split executable and arguments without expanding shell syntax. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next && (/\s/.test(next) || next === "\\" || next === "'" || next === '"')) {
        word += next;
        index += 1;
        started = true;
      } else {
        word += char;
        started = true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote === null) quote = char;
      else word += char;
      started = true;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (quote !== null) throw new Error("Unclosed quote in upload command");
  if (started) words.push(word);
  return words;
}

export function prepareUploadCommand(
  command: string,
  filePath: string,
): { executable: string; args: string[] } {
  const [executable, ...argumentsTemplate] = splitCommand(command);
  if (!executable) throw new Error("Upload command is empty");
  if (executable.includes("%s")) throw new Error("Executable must not contain %s");
  if (
    argumentsTemplate.filter((value) => value === "%s").length !== 1 ||
    argumentsTemplate.some((value) => value !== "%s" && value.includes("%s"))
  ) {
    throw new Error("Upload command must contain exactly one standalone %s argument");
  }
  if (!filePath || filePath.includes("\0")) throw new Error("Invalid attachment path");
  return { executable, args: argumentsTemplate.map((arg) => (arg === "%s" ? filePath : arg)) };
}

export async function executeUploadCommand(command: string, path: string): Promise<string> {
  const { executable, args } = prepareUploadCommand(command, path);
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: UPLOAD_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    shell: false,
    windowsHide: true,
  });
  return stdout;
}

/**
 * 从上传命令的 stdout 中提取 URL。
 * 兼容 URL 中含空格/括号的情况：取到行尾再裁掉包裹的引号。
 */
export function extractUrl(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const labelled = new Set<string>();
  const standalone = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const prefix = /^(?:Output URL|Uploaded|result|URL):\s*(https?:\/\/.*)$/i.exec(line);
    const nextLine = /^(?:Output URL|Uploaded|result|URL):?$/i.test(line);
    let candidate = (prefix?.[1] ?? (nextLine ? lines[i + 1] : line) ?? "").trim();
    candidate = candidate.replace(/^["']|["']$/g, "");
    if (!/^https?:\/\//i.test(candidate)) continue;
    try {
      const result = new URL(candidate);
      if (["http:", "https:"].includes(result.protocol) && result.hostname) {
        (prefix || nextLine ? labelled : standalone).add(candidate);
        if (nextLine) i += 1;
      }
    } catch {
      /* invalid URL, try the next line */
    }
  }
  const candidates = labelled.size > 0 ? labelled : standalone;
  return candidates.size === 1 ? [...candidates][0]! : null;
}

interface PendingUpload {
  run(): void;
}

export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled before execution");
    this.name = "UploadCancelledError";
  }
}

/** One external process at a time. Cancelling a waiter never interrupts a running upload. */
class UploadCommandQueue {
  private running = false;
  private readonly pending: PendingUpload[] = [];

  enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.pending.indexOf(job);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new UploadCancelledError());
      };
      const job: PendingUpload = {
        run: () => {
          signal?.removeEventListener("abort", abort);
          this.running = true;
          void (async () => {
            try {
              resolve(await task());
            } catch (error) {
              reject(error);
            } finally {
              this.running = false;
              this.next();
            }
          })();
        },
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(job);
      this.next();
    });
  }

  private next(): void {
    if (!this.running) this.pending.shift()?.run();
  }
}

export type UploadResult = { success: boolean; url?: string; errorMessage?: string };
export interface UploadOptions {
  command: string;
  signal?: AbortSignal;
  onSuccess?: (url: string) => void;
}
export type UploadFile = (path: string, signal?: AbortSignal) => Promise<UploadResult>;

/** All upload paths share one executor, bounded process contract and serial queue. */
export class Uploader {
  private readonly queue = new UploadCommandQueue();
  private readonly tasks = new Map<string, Promise<UploadResult>>();
  private readonly signalIds = new WeakMap<AbortSignal, number>();
  private nextSignalId = 0;
  private readonly execute: typeof executeUploadCommand;

  constructor(execute: typeof executeUploadCommand = executeUploadCommand) {
    this.execute = execute;
  }

  async uploadFile(path: string, options: UploadOptions): Promise<UploadResult> {
    const { command, signal } = options;
    if (signal?.aborted) throw new UploadCancelledError();
    // Different cancellation scopes must not cancel each other's queued work.
    let signalId = 0;
    if (signal) {
      signalId = this.signalIds.get(signal) ?? ++this.nextSignalId;
      this.signalIds.set(signal, signalId);
    }
    const key = JSON.stringify([command, path, signalId]);
    let task = this.tasks.get(key);
    if (!task) {
      task = this.queue.enqueue(() => this.executeFile(command, path), signal);
      this.tasks.set(key, task);
    }
    try {
      const result = await task;
      if (result.success && result.url) {
        try {
          options.onSuccess?.(result.url);
        } catch {
          // Bookkeeping cannot turn a successful cloud result into a failure.
        }
      }
      return result;
    } finally {
      if (this.tasks.get(key) === task) this.tasks.delete(key);
    }
  }

  private async executeFile(command: string, path: string): Promise<UploadResult> {
    try {
      const stdout = await this.execute(command, path);
      const url = extractUrl(stdout);
      return url
        ? { success: true, url }
        : { success: false, errorMessage: "No valid upload URL was returned" };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
