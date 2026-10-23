const ITEM_INTERVAL_MS = 200;
const SCAN_YIELD_INTERVAL = 16;
const MAX_CONSECUTIVE_FAILURES = 3;

export type MigrationPhase =
  | "idle"
  | "scanning"
  | "ready"
  | "running"
  | "paused"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "error";
export type MigrationReason =
  | "open-note"
  | "note-changed"
  | "note-missing"
  | "source-changed"
  | "read-error"
  | "upload-error"
  | "image-limit"
  | "cancelled"
  | "no-attachments";

export interface MigrationResult {
  path: string;
  status: "updated" | "skipped" | "failed";
  updated: number;
  failed: number;
  reused: number;
  notApplied: number;
  reason?: MigrationReason;
  details?: string;
}

export interface MigrationInspection {
  localPaths: string[];
  remoteUrls: string[];
  missing: number;
}

export interface MigrationPlan {
  paths: readonly string[];
  scanned: number;
  localFiles: number;
  remoteImages: number;
  missingFiles: number;
  scanErrors: readonly MigrationResult[];
}

export interface MigrationContext {
  signal: AbortSignal;
  checkpoint(item?: string): Promise<void>;
  succeeded(): void;
  failed(rateLimited?: boolean): void;
}

export interface MigrationBackend {
  prepare(excluded: readonly string[]): void;
  isCurrent(): boolean;
  listNotes(): string[];
  inspect(path: string): Promise<MigrationInspection>;
  migrate(path: string, context: MigrationContext): Promise<MigrationResult>;
}

export interface MigrationState {
  phase: MigrationPhase;
  scanned: number;
  total: number;
  processed: number;
  current: string;
  item: string;
  pauseReason?: "failures" | "rate-limit";
  error?: string;
  plan?: MigrationPlan;
  results: readonly MigrationResult[];
}

export function normalizeExcludedDirectories(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((entry) =>
          entry
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\/+|\/+$/g, ""),
        )
        .filter(Boolean),
    ),
  ];
}

export function isExcludedPath(path: string, directories: readonly string[]): boolean {
  return directories.some((directory) => path === directory || path.startsWith(`${directory}/`));
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One user-confirmed plan per run. Closing its UI does not own or cancel the task. */
export class BatchMigration {
  private readonly backend: MigrationBackend;
  private readonly listeners = new Set<() => void>();
  private controller = new AbortController();
  private operation?: Promise<void>;
  private wake?: () => void;
  private failureStreak = 0;
  private results: MigrationResult[] = [];
  private current: MigrationState = {
    phase: "idle",
    scanned: 0,
    total: 0,
    processed: 0,
    current: "",
    item: "",
    results: [],
  };

  constructor(backend: MigrationBackend) {
    this.backend = backend;
  }

  get state(): Readonly<MigrationState> {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(change: Partial<MigrationState>): void {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener();
  }

  invalidate(): void {
    if (this.operation) return;
    this.update({ phase: "idle", plan: undefined, results: [], error: undefined });
  }

  async scan(excluded: readonly string[]): Promise<void> {
    if (this.operation) return;
    this.controller = new AbortController();
    const operation = this.scanNotes(excluded);
    this.operation = operation;
    try {
      await operation;
    } finally {
      this.operation = undefined;
    }
  }

  private async scanNotes(excluded: readonly string[]): Promise<void> {
    this.update({
      phase: "scanning",
      scanned: 0,
      total: 0,
      processed: 0,
      current: "",
      item: "",
      plan: undefined,
      results: [],
      error: undefined,
      pauseReason: undefined,
    });
    try {
      this.backend.prepare(excluded);
      const paths = this.backend
        .listNotes()
        .filter((path) => !isExcludedPath(path, excluded))
        .sort();
      this.update({ total: paths.length });
      const selected: string[] = [];
      const local = new Set<string>();
      const remote = new Set<string>();
      const errors: MigrationResult[] = [];
      let missing = 0;
      for (const path of paths) {
        this.controller.signal.throwIfAborted();
        try {
          const inspection = await this.backend.inspect(path);
          if (inspection.localPaths.length || inspection.remoteUrls.length) selected.push(path);
          for (const entry of inspection.localPaths) local.add(entry);
          for (const entry of inspection.remoteUrls) remote.add(entry);
          missing += inspection.missing;
        } catch (error) {
          errors.push({
            path,
            status: "failed",
            updated: 0,
            failed: 0,
            reused: 0,
            notApplied: 0,
            reason: "read-error",
            details: String(error),
          });
        }
        this.update({ scanned: this.current.scanned + 1, current: path });
        if (this.current.scanned % SCAN_YIELD_INTERVAL === 0)
          await delay(0, this.controller.signal);
      }
      this.controller.signal.throwIfAborted();
      this.update({
        phase: "ready",
        current: "",
        plan: {
          paths: selected,
          scanned: paths.length,
          localFiles: local.size,
          remoteImages: remote.size,
          missingFiles: missing,
          scanErrors: errors,
        },
        results: errors,
      });
    } catch (error) {
      this.update({
        phase: this.controller.signal.aborted ? "cancelled" : "error",
        current: "",
        error: this.controller.signal.aborted ? undefined : String(error),
      });
    }
  }

  async start(): Promise<void> {
    if (this.operation) {
      await this.operation;
      return;
    }
    const plan = this.current.plan;
    if (this.current.phase !== "ready" || !plan) return;
    if (!this.backend.isCurrent()) {
      this.update({ phase: "error", error: "settings-changed", plan: undefined });
      return;
    }
    this.controller = new AbortController();
    this.failureStreak = 0;
    const operation = this.run(plan);
    this.operation = operation;
    try {
      await operation;
    } finally {
      this.operation = undefined;
    }
  }

  pause(): void {
    if (this.current.phase === "running") this.update({ phase: "paused", pauseReason: undefined });
  }

  resume(): void {
    if (this.current.phase !== "paused") return;
    this.failureStreak = 0;
    this.update({ phase: "running", pauseReason: undefined });
    this.wake?.();
  }

  cancel(): void {
    if (!this.operation) return;
    this.update({ phase: "cancelling" });
    this.controller.abort();
    this.wake?.();
  }

  private async checkpoint(item?: string): Promise<void> {
    const { signal } = this.controller;
    signal.throwIfAborted();
    while (this.current.phase === "paused") {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
      signal.throwIfAborted();
    }
    await delay(ITEM_INTERVAL_MS, signal);
    if (this.state.phase === "paused") {
      await this.checkpoint(item);
      return;
    }
    signal.throwIfAborted();
    if (item !== undefined) this.update({ item });
  }

  private recordFailure(rateLimited = false): void {
    this.failureStreak += 1;
    if (
      this.current.phase === "running" &&
      (rateLimited || this.failureStreak >= MAX_CONSECUTIVE_FAILURES)
    ) {
      this.update({ phase: "paused", pauseReason: rateLimited ? "rate-limit" : "failures" });
    }
  }

  private async run(plan: MigrationPlan): Promise<void> {
    this.results = [...plan.scanErrors];
    this.update({
      phase: "running",
      total: plan.paths.length,
      processed: 0,
      current: "",
      item: "",
      results: this.results,
      pauseReason: undefined,
    });
    try {
      const context: MigrationContext = {
        signal: this.controller.signal,
        checkpoint: async (item) => await this.checkpoint(item),
        succeeded: () => {
          this.failureStreak = 0;
        },
        failed: (limited) => this.recordFailure(limited),
      };
      for (const path of plan.paths) {
        await this.checkpoint();
        if (!this.backend.isCurrent()) throw new Error("settings-changed");
        this.update({ current: path, item: "" });
        let result: MigrationResult;
        try {
          result = await this.backend.migrate(path, context);
        } catch (error) {
          if (error instanceof Error && error.message === "settings-changed") break;
          result = {
            path,
            status: this.controller.signal.aborted ? "skipped" : "failed",
            updated: 0,
            failed: this.controller.signal.aborted ? 0 : 1,
            reused: 0,
            notApplied: 0,
            reason: this.controller.signal.aborted ? "cancelled" : "read-error",
            details: this.controller.signal.aborted ? undefined : String(error),
          };
          if (!this.controller.signal.aborted) this.recordFailure();
        }
        this.results.push(result);
        this.update({ processed: this.current.processed + 1, results: this.results });
        if (this.controller.signal.aborted) break;
        if (!this.backend.isCurrent()) throw new Error("settings-changed");
      }
      if (!this.controller.signal.aborted && !this.backend.isCurrent())
        throw new Error("settings-changed");
      this.update({
        phase: this.controller.signal.aborted ? "cancelled" : "completed",
        current: "",
        item: "",
      });
    } catch (error) {
      this.update({
        phase: this.controller.signal.aborted ? "cancelled" : "error",
        current: "",
        item: "",
        error: this.controller.signal.aborted ? undefined : String(error),
      });
    }
  }
}
