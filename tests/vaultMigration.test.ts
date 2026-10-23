import { posix } from "node:path";

import type { App, TFile } from "obsidian";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => ({ normalizePath: (path: string) => path, TFile: class {} }));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));
vi.mock("../src/upload/recovery", () => ({
  preserveUploadReceipt: vi.fn<(...args: string[]) => Promise<void>>(async () => {}),
}));

import type { MigrationContext } from "../src/migration/batchMigration";
import { VaultMigration } from "../src/migration/vaultMigration";
import { parseSettings } from "../src/settings";
import { RemoteImageDownloader, RemoteImageDownloadError } from "../src/upload/imageDownloader";
import { preserveUploadReceipt } from "../src/upload/recovery";
import type { UploadFile } from "../src/upload/uploader";

beforeEach(() => {
  vi.mocked(preserveUploadReceipt).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(notes: Record<string, string>, sources = ["assets/a.png"]) {
  const contents = new Map(Object.entries(notes));
  const files = new Map<string, TFile>();
  const stats = new Map<string, { type: "file"; size: number; mtime: number }>();
  for (const path of [...contents.keys(), ...sources]) {
    files.set(path, {
      path,
      name: posix.basename(path),
      extension: posix.extname(path).slice(1),
    } as TFile);
    stats.set(path, { type: "file", size: 10, mtime: 1 });
  }
  const open = new Set<string>();
  const read = vi.fn<(file: TFile) => Promise<string>>(async (file) => {
    const content = contents.get(file.path);
    if (content === undefined) throw new Error("note not found");
    return content;
  });
  const process = vi.fn<(file: TFile, transform: (current: string) => string) => Promise<string>>(
    async (file, transform) => {
      const content = transform(contents.get(file.path) ?? "");
      contents.set(file.path, content);
      return content;
    },
  );
  const trashFile = vi.fn<() => Promise<void>>(async () => {});
  const app = {
    vault: {
      getFiles: () => [...files.values()],
      getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === "md"),
      getFileByPath: (path: string) => files.get(path) ?? null,
      adapter: {
        getBasePath: () => "/vault",
        stat: async (path: string) => stats.get(path) ?? null,
      },
      read,
      process,
    },
    metadataCache: {
      getFirstLinkpathDest: (link: string, note: string) =>
        files.get(posix.normalize(posix.join(posix.dirname(note), link))) ?? null,
    },
    workspace: {
      getLeavesOfType: () =>
        [...open].map((path) => ({ view: { file: files.get(path) }, isDeferred: false })),
    },
    fileManager: { trashFile },
  };
  let uploaded = 0;
  const upload = vi.fn<UploadFile>(async () => ({
    success: true,
    url: `https://new.example/${++uploaded}.png`,
  }));
  const settings = parseSettings({
    uploadService: "custom",
    uploadCommand: "uploader %s",
    uploadFileFormat: "png",
    isDeleteSourceFile: true,
  });
  const outputs = new Set<string>();
  const migration = new VaultMigration(
    app as unknown as App,
    () => settings,
    () => upload,
    () => outputs,
  );
  migration.prepare([]);
  const controller = new AbortController();
  const context: MigrationContext = {
    signal: controller.signal,
    checkpoint: vi.fn<MigrationContext["checkpoint"]>(async () => {
      controller.signal.throwIfAborted();
    }),
    succeeded: vi.fn<() => void>(),
    failed: vi.fn<(limited?: boolean) => void>(),
  };
  return {
    migration,
    contents,
    files,
    stats,
    open,
    read,
    process,
    trashFile,
    upload,
    settings,
    context,
    controller,
  };
}

test("preview never uploads and respects exclusions for referenced local files", async () => {
  const f = fixture(
    {
      "note.md":
        "![](assets/a.png) ![](assets-private/a.png) ![](missing.png) ![](https://old.example/a.png)",
    },
    ["assets/a.png", "assets-private/a.png"],
  );
  f.migration.prepare(["assets"]);
  expect(await f.migration.inspect("note.md")).toEqual({
    localPaths: ["assets-private/a.png"],
    remoteUrls: ["https://old.example/a.png"],
    missing: 1,
  });
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.process).not.toHaveBeenCalled();
});

test("shared local files upload once across notes and local source files are always retained", async () => {
  const f = fixture({ "a.md": "![](assets/a.png)", "b.md": "![[assets/a.png]]" });
  const first = await f.migration.migrate("a.md", f.context);
  const second = await f.migration.migrate("b.md", f.context);
  expect(first).toMatchObject({ status: "updated", updated: 1, reused: 0 });
  expect(second).toMatchObject({ status: "updated", updated: 1, reused: 1 });
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.contents.get("a.md")).toContain("https://new.example/1.png");
  expect(f.contents.get("b.md")).toContain("https://new.example/1.png");
  expect(f.trashFile).not.toHaveBeenCalled();
  expect(f.files.has("assets/a.png")).toBe(true);
});

test("a changed source version is uploaded again rather than reusing an older result", async () => {
  const f = fixture({ "a.md": "![](assets/a.png)", "b.md": "![](assets/a.png)" });
  await f.migration.migrate("a.md", f.context);
  f.stats.set("assets/a.png", { type: "file", size: 11, mtime: 2 });
  const result = await f.migration.migrate("b.md", f.context);
  expect(result.reused).toBe(0);
  expect(f.upload).toHaveBeenCalledTimes(2);
  expect(f.contents.get("b.md")).toContain("https://new.example/2.png");
});

test("same-named files in separate folders remain distinct", async () => {
  const f = fixture({ "a.md": "![](one/a.png)", "b.md": "![](two/a.png)" }, [
    "one/a.png",
    "two/a.png",
  ]);
  await f.migration.migrate("a.md", f.context);
  await f.migration.migrate("b.md", f.context);
  expect(f.upload.mock.calls.map(([path]) => path)).toEqual([
    "/vault/one/a.png",
    "/vault/two/a.png",
  ]);
});

test("already-open notes are skipped before reading or uploading", async () => {
  const f = fixture({ "a.md": "![](assets/a.png)" });
  f.open.add("a.md");
  expect(await f.migration.migrate("a.md", f.context)).toMatchObject({
    status: "skipped",
    reason: "open-note",
  });
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

test.each(["edited", "opened", "renamed"])(
  "a note %s during upload is never overwritten and its cloud result is preserved",
  async (change) => {
    const original = "![](assets/a.png)";
    const f = fixture({ "a.md": original });
    f.upload.mockImplementation(async () => {
      if (change === "edited") f.contents.set("a.md", "user editing");
      if (change === "opened") f.open.add("a.md");
      if (change === "renamed") f.files.get("a.md")!.path = "renamed.md";
      return { success: true, url: "https://new.example/cloud.png" };
    });
    const result = await f.migration.migrate("a.md", f.context);
    expect(result).toMatchObject({ updated: 0, notApplied: 1 });
    expect(f.contents.get("a.md")).toBe(change === "edited" ? "user editing" : original);
    expect(preserveUploadReceipt).toHaveBeenCalledExactlyOnceWith(
      "https://new.example/cloud.png",
      "a.md",
      "a.png",
    );
  },
);

test("a source overwritten during upload retains its local link", async () => {
  const f = fixture({ "a.md": "![](assets/a.png)" });
  f.upload.mockImplementation(async () => {
    f.stats.set("assets/a.png", { type: "file", size: 20, mtime: 2 });
    return { success: true, url: "https://new.example/stale.png" };
  });
  const result = await f.migration.migrate("a.md", f.context);
  expect(result).toMatchObject({ updated: 0, reason: "source-changed", notApplied: 1 });
  expect(f.contents.get("a.md")).toBe("![](assets/a.png)");
  expect(f.trashFile).not.toHaveBeenCalled();
});

test("an individual upload failure leaves its link and continues with the next attachment", async () => {
  const f = fixture({ "a.md": "![](assets/a.png) ![](assets/b.png)" }, [
    "assets/a.png",
    "assets/b.png",
  ]);
  f.upload.mockResolvedValueOnce({ success: false, errorMessage: "tool failed" });
  const result = await f.migration.migrate("a.md", f.context);
  expect(result).toMatchObject({ status: "updated", failed: 1, updated: 1 });
  expect(f.contents.get("a.md")).toContain("![](assets/a.png)");
  expect(f.contents.get("a.md")).toContain("https://new.example/1.png");
  expect(f.context.failed).toHaveBeenCalledTimes(1);
  expect(f.upload).toHaveBeenCalledTimes(2);
});

test("cancelling an active upload preserves the result without writing the note", async () => {
  const f = fixture({ "a.md": "![](assets/a.png)" });
  f.upload.mockImplementation(async () => {
    f.controller.abort();
    return { success: true, url: "https://new.example/cancelled.png" };
  });
  const result = await f.migration.migrate("a.md", f.context);
  expect(result).toMatchObject({ reason: "cancelled", failed: 0, updated: 0, notApplied: 1 });
  expect(f.process).not.toHaveBeenCalled();
  expect(preserveUploadReceipt).toHaveBeenCalledOnce();
});

test("a failed vault write after the transform callback still preserves the cloud result", async () => {
  const f = fixture({ "a.md": "![](assets/a.png)" });
  f.process.mockImplementation(async (file, transform) => {
    transform(f.contents.get(file.path)!);
    throw new Error("disk full");
  });
  const result = await f.migration.migrate("a.md", f.context);
  expect(result).toMatchObject({ status: "failed", updated: 0, notApplied: 1 });
  expect(f.contents.get("a.md")).toBe("![](assets/a.png)");
  expect(preserveUploadReceipt).toHaveBeenCalledOnce();
});

function mockImages() {
  const download = vi
    .spyOn(RemoteImageDownloader.prototype, "download")
    .mockResolvedValue({ path: "/fake/download.png", extension: "png", bytes: 1 });
  vi.spyOn(RemoteImageDownloader.prototype, "release").mockResolvedValue(undefined);
  vi.spyOn(RemoteImageDownloader.prototype, "dispose").mockResolvedValue(undefined);
  return download;
}

test("remote source URLs are downloaded and uploaded once across notes", async () => {
  const download = mockImages();
  const f = fixture(
    { "a.md": "![](https://old.example/a.png)", "b.md": "![alt](https://old.example/a.png)" },
    [],
  );
  const first = await f.migration.migrate("a.md", f.context);
  const second = await f.migration.migrate("b.md", f.context);
  expect(first).toMatchObject({ updated: 1 });
  expect(second).toMatchObject({ updated: 1, reused: 1 });
  expect(download).toHaveBeenCalledOnce();
  expect(f.upload).toHaveBeenCalledOnce();
  expect(f.contents.get("b.md")).toContain("https://new.example/1.png");
});

test("HTTP 429 is reported as a rate limit and the original URL is kept", async () => {
  const download = mockImages();
  download.mockRejectedValue(new RemoteImageDownloadError("http-status", "rate limited", 429));
  const f = fixture({ "a.md": "![](https://old.example/a.png)" }, []);
  const result = await f.migration.migrate("a.md", f.context);
  expect(result.failed).toBe(1);
  expect(f.context.failed).toHaveBeenCalledExactlyOnceWith(true);
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.contents.get("a.md")).toBe("![](https://old.example/a.png)");
});

test("a note with both remote and local attachments rewrites offsets after the remote phase", async () => {
  mockImages();
  const f = fixture({ "a.md": "![remote](https://old.example/a.png)\n\n![](assets/a.png)" });
  const result = await f.migration.migrate("a.md", f.context);
  expect(result).toMatchObject({ status: "updated", updated: 2 });
  expect(f.contents.get("a.md")).toBe(
    "![remote](https://new.example/1.png)\n\n![a.png](https://new.example/2.png)",
  );
  expect(f.upload).toHaveBeenCalledTimes(2);
});

test("a note's remote image limit does not prevent migrating its local attachment", async () => {
  const f = fixture({
    "a.md":
      Array.from({ length: 101 }, (_, i) => `![](https://old.example/${i}.png)`).join("\n") +
      "\n![](assets/a.png)",
  });
  const result = await f.migration.migrate("a.md", f.context);
  expect(result).toMatchObject({ status: "updated", reason: "image-limit", updated: 1, failed: 1 });
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.contents.get("a.md")).toContain("https://old.example/0.png");
  expect(f.contents.get("a.md")).toContain("https://new.example/1.png");
});
