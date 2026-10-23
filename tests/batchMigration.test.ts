import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import {
  BatchMigration,
  isExcludedPath,
  normalizeExcludedDirectories,
  type MigrationBackend,
  type MigrationContext,
  type MigrationResult,
} from "../src/migration/batchMigration";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function result(path: string): MigrationResult {
  return { path, status: "updated", updated: 1, failed: 0, reused: 0, notApplied: 0 };
}
function setup(paths = ["a.md", "b.md"]) {
  const backend = {
    prepare: vi.fn<MigrationBackend["prepare"]>(),
    isCurrent: vi.fn<MigrationBackend["isCurrent"]>(() => true),
    listNotes: () => paths,
    inspect: vi.fn<MigrationBackend["inspect"]>(async () => ({
      localPaths: ["assets/shared.png"],
      remoteUrls: ["https://old.example/shared.png"],
      missing: 0,
    })),
    migrate: vi.fn<MigrationBackend["migrate"]>(async (path) => result(path)),
  };
  return { backend, batch: new BatchMigration(backend) };
}

test("scans without uploading, excludes folder descendants and counts unique sources", async () => {
  const { batch, backend } = setup(["Private/a.md", "PrivateNotes/b.md", "c.md"]);
  expect(isExcludedPath("PrivateNotes/b.md", ["Private"])).toBe(false);
  expect(normalizeExcludedDirectories(" /Private/ \nPrivate\nOther\\Nested ")).toEqual([
    "Private",
    "Other/Nested",
  ]);
  await batch.start();
  expect(backend.migrate).not.toHaveBeenCalled();
  await batch.scan(["Private"]);
  expect(batch.state.plan).toMatchObject({
    paths: ["PrivateNotes/b.md", "c.md"],
    scanned: 2,
    localFiles: 1,
    remoteImages: 1,
  });
  expect(backend.migrate).not.toHaveBeenCalled();
});

test("scan failures are reported without silently losing the remaining notes", async () => {
  const { batch, backend } = setup();
  backend.inspect.mockRejectedValueOnce(new Error("unreadable"));
  await batch.scan([]);
  expect(batch.state.plan?.paths).toEqual(["b.md"]);
  expect(batch.state.plan?.scanErrors).toMatchObject([{ path: "a.md", reason: "read-error" }]);
  expect(batch.state.phase).toBe("ready");
});

test("requires a fresh preview after the exclusion scope changes", async () => {
  const { batch, backend } = setup();
  await batch.scan([]);
  batch.invalidate();
  await batch.start();
  expect(batch.state.phase).toBe("idle");
  expect(backend.migrate).not.toHaveBeenCalled();
});

test("serializes notes, leaves an interval before each item and shares repeated starts", async () => {
  const { batch, backend } = setup();
  const times: number[] = [];
  backend.migrate.mockImplementation(async (path, context) => {
    times.push(Date.now());
    await context.checkpoint("file.png");
    return result(path);
  });
  await batch.scan([]);
  const first = batch.start();
  const second = batch.start();
  await vi.advanceTimersByTimeAsync(199);
  expect(backend.migrate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(backend.migrate).toHaveBeenCalledTimes(1);
  await vi.runAllTimersAsync();
  await Promise.all([first, second]);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(400);
  expect(batch.state.phase).toBe("completed");
  expect(batch.state.processed).toBe(2);
});

test("pause stops subsequent notes, and cancelling a paused task releases it", async () => {
  const { batch, backend } = setup();
  let finish!: () => void;
  backend.migrate.mockImplementationOnce(async (path) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return result(path);
  });
  await batch.scan([]);
  const pending = batch.start();
  await vi.advanceTimersByTimeAsync(200);
  batch.pause();
  finish();
  await vi.runAllTimersAsync();
  expect(batch.state.phase).toBe("paused");
  expect(backend.migrate).toHaveBeenCalledOnce();
  batch.cancel();
  await pending;
  expect(batch.state.phase).toBe("cancelled");
  expect(backend.migrate).toHaveBeenCalledOnce();
});

test("three consecutive failures pause the task until the user resumes", async () => {
  const { batch, backend } = setup(["a.md", "b.md", "c.md", "d.md"]);
  backend.migrate.mockImplementation(async (path, context) => {
    context.failed();
    return { ...result(path), status: "failed", updated: 0, failed: 1 };
  });
  await batch.scan([]);
  const pending = batch.start();
  await vi.runAllTimersAsync();
  expect(batch.state).toMatchObject({ phase: "paused", pauseReason: "failures", processed: 3 });
  expect(backend.migrate).toHaveBeenCalledTimes(3);
  batch.resume();
  await vi.runAllTimersAsync();
  await pending;
  expect(batch.state.phase).toBe("completed");
  expect(backend.migrate).toHaveBeenCalledTimes(4);
});

test("rate limiting pauses before the next item even on the first failure", async () => {
  const { batch, backend } = setup(["a.md"]);
  backend.migrate.mockImplementation(async (path, context) => {
    context.failed(true);
    await context.checkpoint("next.png");
    return result(path);
  });
  await batch.scan([]);
  const pending = batch.start();
  await vi.runAllTimersAsync();
  expect(batch.state).toMatchObject({ phase: "paused", pauseReason: "rate-limit", processed: 0 });
  batch.resume();
  await vi.runAllTimersAsync();
  await pending;
  expect(batch.state.phase).toBe("completed");
});

test("a successful operation resets the consecutive failure count", async () => {
  const { batch, backend } = setup(["a.md"]);
  backend.migrate.mockImplementation(async (path, context) => {
    context.failed();
    context.failed();
    context.succeeded();
    context.failed();
    context.failed();
    return result(path);
  });
  await batch.scan([]);
  const pending = batch.start();
  await vi.runAllTimersAsync();
  await pending;
  expect(batch.state.phase).toBe("completed");
});

test("changing upload settings prevents starting a stale preview", async () => {
  const { batch, backend } = setup();
  await batch.scan([]);
  backend.isCurrent.mockReturnValue(false);
  await batch.start();
  expect(batch.state).toMatchObject({ phase: "error", error: "settings-changed" });
  expect(backend.migrate).not.toHaveBeenCalled();
});

test("changing upload settings while running stops subsequent notes", async () => {
  const { batch, backend } = setup();
  backend.migrate.mockImplementationOnce(async (path) => {
    backend.isCurrent.mockReturnValue(false);
    return result(path);
  });
  await batch.scan([]);
  const pending = batch.start();
  await vi.runAllTimersAsync();
  await pending;
  expect(batch.state.phase).toBe("error");
  expect(backend.migrate).toHaveBeenCalledOnce();
});

test("unsubscribing a closed panel leaves the running task independent", async () => {
  const { batch, backend } = setup();
  const listener = vi.fn<() => void>();
  const unsubscribe = batch.subscribe(listener);
  await batch.scan([]);
  const pending = batch.start();
  unsubscribe();
  await vi.runAllTimersAsync();
  await pending;
  expect(batch.state.phase).toBe("completed");
  expect(backend.migrate).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalled();
});

test("a settings change detected by the note itself is not reported as a read failure", async () => {
  const { batch, backend } = setup();
  backend.migrate.mockImplementationOnce(async () => {
    backend.isCurrent.mockReturnValue(false);
    throw new Error("settings-changed");
  });
  await batch.scan([]);
  const pending = batch.start();
  await vi.runAllTimersAsync();
  await pending;
  expect(batch.state.phase).toBe("error");
  expect(batch.state.results).toEqual([]);
});

test("cancelling during an active item retains the returned recovery outcome", async () => {
  const { batch, backend } = setup();
  let context: MigrationContext | undefined;
  let finish!: (value: MigrationResult) => void;
  backend.migrate.mockImplementationOnce(async (_path, value) => {
    context = value;
    return await new Promise((resolve) => {
      finish = resolve;
    });
  });
  await batch.scan([]);
  const pending = batch.start();
  await vi.advanceTimersByTimeAsync(200);
  batch.cancel();
  expect(context?.signal.aborted).toBe(true);
  finish({ ...result("a.md"), updated: 0, notApplied: 1, reason: "cancelled" });
  await pending;
  expect(batch.state).toMatchObject({ phase: "cancelled", processed: 1 });
  expect(batch.state.results[0]?.notApplied).toBe(1);
  expect(backend.migrate).toHaveBeenCalledOnce();
});
