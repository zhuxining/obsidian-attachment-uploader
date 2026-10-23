import { ChangeSet, Text, type ChangeSpec } from "@codemirror/state";
import { expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path,
}));

import { applyTextChanges, type TextChange } from "../src/attachments/imageRewriter";
import { RemoteImageDownloadError } from "../src/upload/imageDownloader";
import {
  captureRemoteImageReferences,
  ImageTransferService,
  type ImageTransferDeps,
  type RemoteImageScope,
  type RemoteImageTransferSettings,
  type TransferDownloader,
  type TransferProgress,
} from "../src/upload/remoteImages";
import { Uploader } from "../src/upload/uploader";

function settings(overrides: Partial<RemoteImageTransferSettings> = {}) {
  return {
    uploadFileFormat: new Set([".png"]),
    prefixes: [],
    ...overrides,
  } satisfies RemoteImageTransferSettings;
}

function createDocument(initial: string, options: { live?: boolean } = {}) {
  let content = initial;
  const read = vi.fn<() => Promise<{ content: string; live: boolean } | null>>(async () => ({
    content,
    live: options.live ?? true,
  }));
  const apply = vi.fn<(base: string, changes: readonly TextChange[]) => Promise<boolean>>(
    async (base, changes) => {
      if (content !== base) return false;
      content = applyTextChanges(base, changes);
      return true;
    },
  );
  return {
    getValue: () => content,
    setValue: (value: string) => {
      content = value;
    },
    read,
    apply,
  };
}

function createDownloader(options: { fail?: Map<string, string> } = {}) {
  let counter = 0;
  const downloads: string[] = [];
  const released: string[] = [];
  const downloader: TransferDownloader & {
    downloads: string[];
    released: string[];
  } = {
    downloads,
    released,
    download: vi.fn<TransferDownloader["download"]>(async (url) => {
      downloads.push(url);
      const failure = options.fail?.get(url);
      if (failure) throw new RemoteImageDownloadError(failure as "network");
      counter += 1;
      const extension = new URL(url).pathname.split(".").pop()?.toLowerCase() || "png";
      return { path: `/tmp/download-${counter}.${extension}`, extension, bytes: 10 };
    }),
    release: vi.fn<TransferDownloader["release"]>(async (path) => {
      released.push(path);
    }),
  };
  return downloader;
}

function createHarness(
  content: string,
  options: {
    live?: boolean;
    upload?: (path: string) => Promise<{ success: boolean; url?: string }>;
    downloader?: ReturnType<typeof createDownloader>;
    sessionOutputs?: Set<string>;
  } = {},
) {
  const document = createDocument(content, { live: options.live });
  const downloader = options.downloader ?? createDownloader();
  let uploads = 0;
  const upload = vi.fn<ImageTransferDeps["upload"]>(
    options.upload ??
      (async () => {
        uploads += 1;
        return { success: true, url: `https://cdn.example/uploaded-${uploads}.png` };
      }),
  );
  const preserveReceipt = vi.fn<ImageTransferDeps["preserveReceipt"]>(async () => {});
  const sessionOutputs = options.sessionOutputs ?? new Set<string>();
  const deps: ImageTransferDeps = {
    document,
    downloader,
    upload,
    preserveReceipt,
    sessionOutputs,
  };
  const service = new ImageTransferService(deps);
  const progress: TransferProgress[] = [];
  const trackers = new Set<ReturnType<typeof captureRemoteImageReferences>>();
  const capture = (scope: RemoteImageScope) => {
    scope.tracker ??= captureRemoteImageReferences(document.getValue(), scope);
    trackers.add(scope.tracker);
    return scope;
  };
  const edit = (spec: ChangeSpec) => {
    const before = document.getValue();
    const changes = ChangeSet.of(spec, before.length);
    const after = changes.apply(Text.of(before.split("\n"))).toString();
    for (const tracker of trackers) tracker.update(before, after, changes);
    document.setValue(after);
  };

  const run = (
    scope: RemoteImageScope,
    overrides: {
      settings?: RemoteImageTransferSettings;
      signal?: AbortSignal;
    } = {},
  ) =>
    service.transfer({
      sourcePath: "note.md",
      scope: capture(scope),
      settings: overrides.settings ?? settings(),
      signal: overrides.signal ?? new AbortController().signal,
      onProgress: (value) => progress.push(value),
    });
  return {
    document,
    downloader,
    upload,
    preserveReceipt,
    sessionOutputs,
    service,
    run,
    progress,
    edit,
    capture,
  };
}

test("deduplicates identical URLs into one download and one upload", async () => {
  const harness = createHarness(
    [
      "![](https://cdn.example/a.png)",
      "![](https://cdn.example/a.png)",
      "![](https://cdn.example/a.png)",
    ].join("\n"),
  );
  const summary = await harness.run({ kind: "note" });
  expect(harness.downloader.downloads).toEqual(["https://cdn.example/a.png"]);
  expect(harness.upload).toHaveBeenCalledOnce();
  expect(harness.document.getValue()).toBe(
    [
      "![](https://cdn.example/uploaded-1.png)",
      "![](https://cdn.example/uploaded-1.png)",
      "![](https://cdn.example/uploaded-1.png)",
    ].join("\n"),
  );
  expect(summary).toMatchObject({
    totalReferences: 3,
    uniqueUrls: 1,
    succeeded: 1,
    failed: 0,
    notApplied: 0,
    skipped: 0,
  });
});

test("skips own prefixes and known session outputs", async () => {
  const own = {
    text: "https://cdn.example/blog/",
    protocol: "https:" as const,
    hostname: "cdn.example",
    port: "",
    pathname: "/blog/",
  };
  const content = [
    "![](https://cdn.example/blog/a.png)",
    "![](https://cdn.example/uploaded-old.png)",
  ].join("\n");
  const sessionOutputs = new Set(["https://cdn.example/uploaded-old.png"]);
  const first = createHarness(content, { sessionOutputs });
  const skipped = await first.run({ kind: "note" }, { settings: settings({ prefixes: [own] }) });
  expect(skipped.skipped).toBe(2);
  expect(first.downloader.downloads).toEqual([]);
});

test.each([
  ["https://cdn.example/截图.png", "https://cdn.example/%E6%88%AA%E5%9B%BE.png"],
  ["https://cdn.example/a b.png", "https://cdn.example/a%20b.png"],
  ["https://cdn.example/a%2520b.png", "https://cdn.example/a%20b.png"],
  ["https://cdn.example/a (1).png", "<https://cdn.example/a%20(1).png>"],
])("skips a previously uploaded URL after Markdown normalization: %s", async (url, destination) => {
  const harness = createHarness("![](https://source.example/a.png)", {
    upload: async () => ({ success: true, url }),
  });
  const first = await harness.run({ kind: "note" });
  expect(first.succeeded).toBe(1);
  expect(harness.document.getValue()).toBe(`![](${destination})`);

  const second = await harness.run({ kind: "note" });
  expect(second).toMatchObject({ succeeded: 0, skipped: 1, failed: 0 });
  expect(harness.downloader.downloads).toHaveLength(1);
  expect(harness.upload).toHaveBeenCalledOnce();
});

test("cancelling a queued upload does not count as an upload failure", async () => {
  const controller = new AbortController();
  let release!: (stdout: string) => void;
  const execute = vi.fn<(command: string, path: string) => Promise<string>>(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const uploader = new Uploader(execute);
  const blocker = uploader.uploadFile("/blocker.png", { command: "uploader %s" });
  const original = "![](https://source.example/a.png)";
  const harness = createHarness(original, {
    upload: async () => {
      const pending = uploader.uploadFile("/queued.png", {
        command: "uploader %s",
        signal: controller.signal,
      });
      controller.abort();
      return await pending;
    },
  });
  try {
    const summary = await harness.run({ kind: "note" }, { signal: controller.signal });
    expect(summary).toMatchObject({ cancelled: true, failed: 0, succeeded: 0, errors: [] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.document.getValue()).toBe(original);
    expect(harness.downloader.released).toEqual(["/tmp/download-1.png"]);
    expect(harness.preserveReceipt).not.toHaveBeenCalled();
  } finally {
    release("https://cdn.example/blocker.png");
    await blocker;
  }
  expect(execute).toHaveBeenCalledTimes(1);
});

test("keeps a real upload failure when cancellation happens during execution", async () => {
  const controller = new AbortController();
  const harness = createHarness("![](https://source.example/a.png)", {
    upload: async () => {
      controller.abort();
      throw new Error("Uploader failed");
    },
  });
  const summary = await harness.run({ kind: "note" }, { signal: controller.signal });
  expect(summary).toMatchObject({ cancelled: true, failed: 1 });
  expect(summary.errors).toEqual([{ code: "upload-failed", url: "https://source.example/a.png" }]);
});

test("keeps the original link when a download fails", async () => {
  const downloader = createDownloader({
    fail: new Map([["https://cdn.example/a.png", "not-an-image"]]),
  });
  const harness = createHarness("![](https://cdn.example/a.png)", { downloader });
  const summary = await harness.run({ kind: "note" });
  expect(harness.document.getValue()).toBe("![](https://cdn.example/a.png)");
  expect(harness.upload).not.toHaveBeenCalled();
  expect(summary.failed).toBe(1);
  expect(summary.errors).toEqual([{ code: "not-an-image", url: "https://cdn.example/a.png" }]);
});

test("keeps the original link when the upload command fails", async () => {
  const harness = createHarness("![](https://cdn.example/a.png)", {
    upload: async () => ({ success: false, url: undefined }),
  });
  const summary = await harness.run({ kind: "note" });
  expect(harness.document.getValue()).toBe("![](https://cdn.example/a.png)");
  expect(summary.failed).toBe(1);
  expect(summary.succeeded).toBe(0);
});

test("refuses to process more unique URLs than the batch limit", async () => {
  const content = Array.from(
    { length: 3 },
    (_, index) => `![](https://cdn.example/${index}.png)`,
  ).join("\n");
  const harness = createHarness(content);
  const summary = await harness.run({ kind: "note" }, { settings: settings({ maxUniqueUrls: 2 }) });
  expect(summary.limitExceeded).toBe(true);
  expect(summary.uniqueUrls).toBe(3);
  expect(harness.downloader.downloads).toEqual([]);
  expect(harness.document.getValue()).toBe(content);
});

test("does not write anything after cancellation and preserves successful URLs", async () => {
  const controller = new AbortController();
  const harness = createHarness("![](https://cdn.example/a.png)", {
    upload: async () => {
      controller.abort();
      return { success: true, url: "https://cdn.example/uploaded.png" };
    },
  });
  const summary = await harness.run({ kind: "note" }, { signal: controller.signal });
  expect(summary.cancelled).toBe(true);
  expect(summary.succeeded).toBe(0);
  expect(summary.notApplied).toBe(1);
  expect(harness.document.apply).not.toHaveBeenCalled();
  expect(harness.preserveReceipt).toHaveBeenCalledWith(
    "https://cdn.example/uploaded.png",
    "note.md",
    "uploaded.png",
  );
});

test("does not overwrite a non-live document that changed while uploading", async () => {
  const harness = createHarness("![](https://cdn.example/a.png)", {
    live: false,
    upload: async () => {
      harness.document.setValue("user edited elsewhere");
      return { success: true, url: "https://cdn.example/uploaded.png" };
    },
  });
  const summary = await harness.run({ kind: "note" });
  expect(harness.document.getValue()).toBe("user edited elsewhere");
  expect(harness.document.apply).not.toHaveBeenCalled();
  expect(summary.notApplied).toBe(1);
  expect(harness.preserveReceipt).toHaveBeenCalledOnce();
});

test("relocates a note range after earlier edits", async () => {
  const original = "before ![](https://cdn.example/a.png) after";
  const harness = createHarness(original, {
    upload: async () => {
      harness.edit({ from: 0, insert: "new introduction\n" });
      return { success: true, url: "https://cdn.example/uploaded.png" };
    },
  });
  const start = original.indexOf("![]");
  const summary = await harness.run({
    kind: "paste",
    start,
    end: start + "![](https://cdn.example/a.png)".length,
    anchorText: "![](https://cdn.example/a.png)",
  });
  expect(summary.succeeded).toBe(1);
  expect(harness.document.getValue()).toBe(
    "new introduction\nbefore ![](https://cdn.example/uploaded.png) after",
  );
});

test("only rewrites references inside the pasted range", async () => {
  const content = "![](https://cdn.example/a.png)\n\n![](https://cdn.example/a.png)";
  const harness = createHarness(content);
  const first = content.indexOf("![]");
  const end = first + "![](https://cdn.example/a.png)".length;
  const summary = await harness.run({
    kind: "paste",
    start: first,
    end,
    anchorText: "![](https://cdn.example/a.png)",
  });
  expect(summary.succeeded).toBe(1);
  const updated = harness.document.getValue();
  expect(updated).toBe("![](https://cdn.example/uploaded-1.png)\n\n![](https://cdn.example/a.png)");
});

test("skips formats excluded by the existing upload settings", async () => {
  const harness = createHarness("![](https://cdn.example/a.svg)");
  const summary = await harness.run(
    { kind: "note" },
    { settings: settings({ uploadFileFormat: new Set([".png"]) }) },
  );
  expect(summary.skipped).toBe(1);
  expect(summary.failed).toBe(0);
  expect(harness.upload).not.toHaveBeenCalled();
  expect(harness.document.getValue()).toBe("![](https://cdn.example/a.svg)");
});

test("inlines the transferred image and preserves a shared ordinary link", async () => {
  const content = ["![a][photo] [download][photo]", "", "[photo]: https://cdn.example/a.png"].join(
    "\n",
  );
  const harness = createHarness(content);
  const summary = await harness.run({ kind: "note" });
  expect(summary.succeeded).toBe(1);
  const updated = harness.document.getValue();
  expect(updated).toBe(
    [
      "![a](https://cdn.example/uploaded-1.png) [download][photo]",
      "",
      "[photo]: https://cdn.example/a.png",
    ].join("\n"),
  );
});

test("reports progress and releases every temporary file", async () => {
  const harness = createHarness("![](https://cdn.example/a.png)\n![](https://cdn.example/b.png)");
  await harness.run({ kind: "note" });
  expect(harness.progress.map((item) => item.phase)).toContain("downloading");
  expect(harness.progress.map((item) => item.phase)).toContain("uploading");
  expect(harness.progress.map((item) => item.phase)).toContain("applying");
  expect(harness.downloader.released.sort()).toEqual([
    "/tmp/download-1.png",
    "/tmp/download-2.png",
  ]);
});

test("treats an unavailable document as a no-op", async () => {
  const harness = createHarness("![](https://cdn.example/a.png)");
  harness.document.read.mockResolvedValueOnce(null);
  const summary = await harness.run({ kind: "note" });
  expect(summary.totalReferences).toBe(0);
  expect(harness.downloader.downloads).toEqual([]);
});

test("keeps duplicate pasted ranges separate by their captured identity", async () => {
  const anchor = "![](https://cdn.example/a.png)";
  const content = `${anchor}\n${anchor}`;
  const start = content.indexOf(anchor, 1);
  const harness = createHarness(content);
  const summary = await harness.run({
    kind: "paste",
    start,
    end: start + anchor.length,
    anchorText: anchor,
  });
  expect(summary.succeeded).toBe(1);
  expect(harness.document.getValue()).toBe(
    "![](https://cdn.example/a.png)\n![](https://cdn.example/uploaded-1.png)",
  );
});

test("refuses to relocate an ambiguous pasted range after the document changed", async () => {
  const anchor = "![](https://cdn.example/a.png)";
  const harness = createHarness(anchor, {
    upload: async () => {
      harness.document.setValue(`prefix ${anchor} ${anchor}`);
      return { success: true, url: "https://cdn.example/uploaded.png" };
    },
  });
  const summary = await harness.run({
    kind: "paste",
    start: 0,
    end: anchor.length,
    anchorText: anchor,
  });
  expect(summary.succeeded).toBe(0);
  expect(summary.notApplied).toBe(1);
  expect(harness.document.apply).not.toHaveBeenCalled();
  expect(harness.preserveReceipt).toHaveBeenCalledOnce();
});

test("relocates the pasted range before selecting candidates when earlier edits shifted it", async () => {
  const anchor = "![](https://cdn.example/a.png)";
  const harness = createHarness(anchor);
  const scope = harness.capture({
    kind: "paste",
    start: 0,
    end: anchor.length,
    anchorText: anchor,
  });
  harness.edit({ from: 0, insert: "new prefix\n" });
  const summary = await harness.run(scope);
  expect(summary.succeeded).toBe(1);
  expect(harness.document.getValue()).toBe("new prefix\n![](https://cdn.example/uploaded-1.png)");
});

test("treats jpg and jpeg as the same configured format", async () => {
  const harness = createHarness("![](https://cdn.example/a.jpg)");
  const summary = await harness.run(
    { kind: "note" },
    { settings: settings({ uploadFileFormat: new Set([".jpeg"]) }) },
  );
  expect(summary.succeeded).toBe(1);
  expect(harness.upload).toHaveBeenCalledOnce();
});

test("does not fall back to stale paste offsets after the pasted block was deleted", async () => {
  const harness = createHarness("unrelated ![](https://cdn.example/a.png)");
  const summary = await harness.run({
    kind: "paste",
    start: 0,
    end: 20,
    anchorText: "deleted pasted block",
  });
  expect(summary.totalReferences).toBe(0);
  expect(harness.downloader.downloads).toEqual([]);
  expect(harness.document.getValue()).toBe("unrelated ![](https://cdn.example/a.png)");
});

test("deleting the pasted duplicate never reclaims the original image", async () => {
  const anchor = "![](https://cdn.example/a.png)";
  const harness = createHarness(`${anchor}\n\n${anchor}`, {
    upload: async () => {
      harness.edit({ from: anchor.length, to: harness.document.getValue().length });
      return { success: true, url: "https://own.example/new.png" };
    },
  });
  const summary = await harness.run({
    kind: "paste",
    start: anchor.length + 2,
    end: harness.document.getValue().length,
    anchorText: anchor,
  });
  expect(harness.document.getValue()).toBe(anchor);
  expect(summary.notApplied).toBe(1);
  expect(harness.preserveReceipt).toHaveBeenCalledOnce();
});

test("deleting then undoing an image does not restore its upload identity", async () => {
  const anchor = "![](https://cdn.example/a.png)";
  const harness = createHarness(anchor, {
    upload: async () => {
      harness.edit({ from: 0, to: anchor.length });
      harness.edit({ from: 0, insert: anchor });
      return { success: true, url: "https://own.example/new.png" };
    },
  });
  const summary = await harness.run({ kind: "note" });
  expect(harness.document.getValue()).toBe(anchor);
  expect(summary.notApplied).toBe(1);
});

test("keeps unaffected images while rejecting a changed reference definition", async () => {
  const content = "![a][ref]\n![](https://cdn.example/b.png)\n\n[ref]: https://cdn.example/a.png";
  const harness = createHarness(content, {
    upload: async () => {
      const start = harness.document.getValue().indexOf("[ref]:");
      harness.edit({
        from: start,
        to: harness.document.getValue().length,
        insert: "[ref]: https://other.example/a.png",
      });
      return { success: true, url: "https://own.example/new.png" };
    },
  });
  const summary = await harness.run({ kind: "note" });
  expect(summary.succeeded).toBe(1);
  expect(summary.notApplied).toBe(1);
  expect(harness.document.getValue()).toContain("[ref]: https://other.example/a.png");
});

test("does not acquire images inserted after a whole-note operation began", async () => {
  const anchor = "![](https://cdn.example/a.png)";
  const harness = createHarness(anchor, {
    upload: async () => {
      harness.edit({ from: anchor.length, insert: `\n${anchor}` });
      return { success: true, url: "https://own.example/new.png" };
    },
  });
  await harness.run({ kind: "note" });
  expect(harness.document.getValue()).toBe(`![](https://own.example/new.png)\n${anchor}`);
});

test("loss of editor tracking permanently prevents application", async () => {
  const anchor = "![](https://cdn.example/a.png)";
  const scope: RemoteImageScope = { kind: "note" };
  const harness = createHarness(anchor, {
    upload: async () => {
      scope.tracker!.detach();
      return { success: true, url: "https://own.example/new.png" };
    },
  });
  const summary = await harness.run(scope);
  expect(summary.notApplied).toBe(1);
  expect(harness.document.getValue()).toBe(anchor);
});

test("cancelling during the final source read prevents replacement and preserves the result", async () => {
  const controller = new AbortController();
  const anchor = "![](https://cdn.example/a.png)";
  const harness = createHarness(anchor);
  let reads = 0;
  harness.document.read.mockImplementation(async () => {
    if (++reads === 2) controller.abort();
    return { content: anchor, live: true };
  });
  const summary = await harness.run({ kind: "note" }, { signal: controller.signal });
  expect(harness.document.apply).not.toHaveBeenCalled();
  expect(harness.preserveReceipt).toHaveBeenCalledOnce();
  expect(summary).toMatchObject({ cancelled: true, notApplied: 1 });
});

test("allows more than 100 URLs when configured and forwards download limits", async () => {
  const content = Array.from(
    { length: 101 },
    (_, index) => `![](https://cdn.example/${index}.png)`,
  ).join("\n");
  const harness = createHarness(content);
  const summary = await harness.run(
    { kind: "note" },
    {
      settings: settings({
        maxUniqueUrls: 101,
        maxImageBytes: 80 * 1024 * 1024,
        batchBytes: 1000 * 1024 * 1024,
        downloadTimeoutMs: 120_000,
        downloadConcurrency: 1,
      }),
    },
  );
  expect(summary.limitExceeded).toBe(false);
  expect(summary.succeeded).toBe(101);
  expect(harness.downloader.download).toHaveBeenCalledTimes(101);
  expect(harness.downloader.download).toHaveBeenCalledWith("https://cdn.example/0.png", {
    signal: expect.any(AbortSignal),
    maxBytes: 80 * 1024 * 1024,
    timeoutMs: 120_000,
    budget: { used: 0, limit: 1000 * 1024 * 1024 },
  });
});
