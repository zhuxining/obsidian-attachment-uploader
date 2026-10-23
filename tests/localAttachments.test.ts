import { type App, type EditorTransaction, TFile } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path,
  Notice: class {},
  TFile: class {},
}));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));

import { formatUploadedFile } from "../src/attachments/imageRewriter";
import { AttachmentMatcher } from "../src/attachments/vaultAttachments";
import { LocalAttachments } from "../src/upload/localAttachments";
import { preserveUploadReceipt } from "../src/upload/recovery";
import { executeUploadCommand, Uploader } from "../src/upload/uploader";

vi.mock("../src/upload/recovery", () => ({
  preserveUploadReceipt: vi.fn<typeof preserveUploadReceipt>(),
}));
beforeEach(() => vi.mocked(preserveUploadReceipt).mockClear());

vi.mock("../src/upload/uploader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/upload/uploader")>()),
  executeUploadCommand: vi.fn<typeof executeUploadCommand>(),
}));

function createLocalAttachments(
  command: string,
  deleteSource: boolean,
  formats: Set<string>,
  uploader = new Uploader(executeUploadCommand),
) {
  return new LocalAttachments(
    (path, signal) => uploader.uploadFile(path, { command, signal }),
    deleteSource,
    formats,
  );
}

function editor(initial: string) {
  let content = initial;
  return {
    getValue: () => content,
    setValue: (value: string) => {
      content = value;
    },
    offsetToPos: (offset: number) => {
      const lines = content.slice(0, offset).split("\n");
      return { line: lines.length - 1, ch: lines.at(-1)!.length };
    },
    transaction: vi.fn<(tx: EditorTransaction) => void>((tx) => {
      const offset = (pos: { line: number; ch: number }) =>
        content
          .split("\n")
          .slice(0, pos.line)
          .reduce((sum, line) => sum + line.length + 1, 0) + pos.ch;
      const changes = (tx.changes ?? []).map((change) => ({
        start: offset(change.from),
        end: offset(change.to ?? change.from),
        text: change.text,
      }));
      for (const change of changes.sort((a, b) => b.start - a.start)) {
        content = content.slice(0, change.start) + change.text + content.slice(change.end);
      }
    }),
  };
}

function fixture() {
  const files = [
    { path: "assets/a.png", name: "a.png" },
    { path: "notes/assets/a.png", name: "a.png" },
  ];
  const root = { file: { path: "root.md" } as TFile, editor: editor("![[assets/a.png]]") };
  const nested = { file: { path: "notes/note.md" } as TFile, editor: editor("![](assets/a.png)") };
  const app = {
    vault: {
      getFiles: () => files,
      getAbstractFileByPath: () => null,
      adapter: { getBasePath: () => "/vault" },
    },
    metadataCache: {
      getFirstLinkpathDest: (link: string, note: string) => {
        if (link !== "assets/a.png") return null;
        return note.startsWith("notes/") ? files[1] : files[0];
      },
    },
    workspace: { getLeavesOfType: () => [{ view: root }, { view: nested }] },
  };
  return { files, root, nested, app: app as unknown as App };
}

function deletionFixture() {
  const source = Object.assign(new TFile(), {
    path: "assets/a.png",
    name: "a.png",
    extension: "png",
  });
  const note = Object.assign(new TFile(), {
    path: "root.md",
    name: "root.md",
    extension: "md",
  });
  const root = { file: note, editor: editor("![[assets/a.png]]") };
  const leaves = [{ view: root }];
  const files = [source, note];
  const cachedRead = vi.fn<App["vault"]["cachedRead"]>(async () => "No remaining references");
  const stat = vi.fn<(path: string) => Promise<{ type: string; size: number; mtime: number }>>(
    async () => ({ type: "file", size: 10, mtime: 1 }),
  );
  const trashFile = vi.fn<App["fileManager"]["trashFile"]>(async () => {});
  const getAbstractFileByPath = vi.fn<(path: string) => TFile | null>((path) =>
    path === source.path ? source : null,
  );
  const app = {
    vault: {
      getFiles: () => files,
      getAbstractFileByPath,
      cachedRead,
      adapter: { getBasePath: () => "/vault", stat },
    },
    metadataCache: { getFirstLinkpathDest: () => source },
    workspace: { getLeavesOfType: () => leaves },
    fileManager: { trashFile },
  } as unknown as App;
  const service = createLocalAttachments("", true, new Set([".png"]));
  const upload = vi.spyOn(service, "uploadFile").mockResolvedValue({
    success: true,
    url: "https://cdn.example/a.png",
  });
  const attachment = new AttachmentMatcher(app).getEditorAttachments(root)[0]!;
  const process = () => service.processAttachment(attachment, root, app);
  return {
    source,
    note,
    root,
    leaves,
    files,
    cachedRead,
    stat,
    trashFile,
    getAbstractFileByPath,
    upload,
    process,
  };
}

describe("conservative source deletion", () => {
  test("bounds disk reads and yields to the event loop while preserving a large vault", async () => {
    const context = deletionFixture();
    for (let index = 0; index < 200; index++) {
      context.files.push(Object.assign(new TFile(), { path: `${index}.md`, extension: "md" }));
    }
    let yielded = false;
    const timer = setTimeout(() => {
      yielded = true;
    }, 0);
    try {
      await context.process();
      expect(yielded).toBe(true);
      expect(context.cachedRead.mock.calls.length).toBeGreaterThan(0);
      expect(context.cachedRead.mock.calls.length).toBeLessThanOrEqual(128);
      expect(context.trashFile).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
    }
  });

  test("rereads notes on the next operation even when metadata is identical", async () => {
    const context = deletionFixture();
    context.cachedRead.mockResolvedValue("clean");
    await context.process();
    expect(context.cachedRead).toHaveBeenCalledTimes(1);
    context.trashFile.mockClear();
    context.root.editor.setValue("![[assets/a.png]]");
    context.cachedRead.mockResolvedValue("![[assets/a.png]]");
    await context.process();
    expect(context.cachedRead).toHaveBeenCalledTimes(2);
    expect(context.trashFile).not.toHaveBeenCalled();
  });

  test("preserves oversized text without attempting unbounded normalization", async () => {
    const context = deletionFixture();
    context.cachedRead.mockResolvedValue("x".repeat(256 * 1024 + 1));
    await context.process();
    expect(context.cachedRead).toHaveBeenCalledTimes(1);
    expect(context.trashFile).not.toHaveBeenCalled();
  });

  test("trashes the actual source file when only the uploaded remote link remains", async () => {
    const context = deletionFixture();
    await context.process();
    expect(context.root.editor.getValue()).toBe("![a.png](https://cdn.example/a.png)");
    expect(context.cachedRead).toHaveBeenCalledWith(context.note);
    expect(context.trashFile).toHaveBeenCalledExactlyOnceWith(context.source);
  });

  test("preserves a reference in a second view of the same note", async () => {
    const context = deletionFixture();
    context.leaves.push({ view: { file: context.note, editor: editor("![[assets/a.png]]") } });
    // A later clean view must not overwrite the second view's reference.
    context.leaves.push({ view: { file: context.note, editor: editor("clean") } });
    await context.process();
    expect(context.trashFile).not.toHaveBeenCalled();
  });

  test.each([
    String.raw`![](assets/a\.png)`,
    String.raw`[download](assets/a\.png)`,
    "![attachment][image]\n\n[image]: assets/a\\.png",
    String.raw`![](assets\/a\.png)`,
    "![](assets%2Fa%5C.png)",
  ])("preserves escaped disk references: %s", async (content) => {
    const context = deletionFixture();
    context.cachedRead.mockResolvedValue(content);
    await context.process();
    expect(context.trashFile).not.toHaveBeenCalled();
    expect(context.root.editor.getValue()).toContain("https://cdn.example/a.png");
  });

  test.each([
    String.raw`![](assets/a\.png)`,
    String.raw`[download](assets/a\.png)`,
    "![attachment][image]\n\n[image]: assets/a\\.png",
    String.raw`![](assets\/a\.png)`,
    "![](assets%2Fa%5C.png)",
  ])("preserves escaped references in another open view: %s", async (content) => {
    const context = deletionFixture();
    context.leaves.push({ view: { file: context.note, editor: editor(content) } });
    await context.process();
    expect(context.trashFile).not.toHaveBeenCalled();
    expect(context.root.editor.getValue()).toContain("https://cdn.example/a.png");
  });

  test.each([
    "![](assets/a.png)",
    "![](assets%2F%61%2Epng)",
    "![](assets%252F%2561%252Epng)",
    "![](assets/%broken%61%2Epng)",
    "![](assets/%FF%61%2Epng)",
    "![](assets/&#97;.png)",
    "![](assets/%252525252561.png)",
  ])("preserves disk references or uncertain encoding: %s", async (content) => {
    const context = deletionFixture();
    context.cachedRead.mockResolvedValue(content);
    await context.process();
    expect(context.trashFile).not.toHaveBeenCalled();
    expect(context.root.editor.getValue()).toContain("https://cdn.example/a.png");
  });

  test("decodes canvas JSON Unicode and slash escapes before checking references", async () => {
    const context = deletionFixture();
    const canvas = Object.assign(new TFile(), { path: "drawing.canvas", extension: "canvas" });
    context.files.push(canvas);
    context.cachedRead.mockImplementation(async (file) =>
      file === canvas ? String.raw`{"nodes":[{"file":"assets\/\u0061\u002epng"}]}` : "clean",
    );
    await context.process();
    expect(context.trashFile).not.toHaveBeenCalled();
  });

  test("read failures preserve the source without rejecting the upload", async () => {
    const context = deletionFixture();
    context.cachedRead.mockRejectedValue(new Error("read failed"));
    await expect(context.process()).resolves.toBe("succeeded");
    expect(context.trashFile).not.toHaveBeenCalled();
    expect(context.root.editor.getValue()).toContain("https://cdn.example/a.png");
  });

  test("rechecks editors changed while disk scanning was awaiting a read", async () => {
    const context = deletionFixture();
    context.cachedRead.mockImplementation(async () => {
      context.leaves.push({ view: { file: context.note, editor: editor("![[assets/a.png]]") } });
      return "clean";
    });
    await context.process();
    expect(context.trashFile).not.toHaveBeenCalled();
  });

  test.each(["size", "mtime", "identity", "path"])(
    "preserves a source whose %s changed during upload",
    async (change) => {
      const context = deletionFixture();
      context.upload.mockImplementation(async () => {
        if (change === "size") context.stat.mockResolvedValue({ type: "file", size: 11, mtime: 1 });
        if (change === "mtime")
          context.stat.mockResolvedValue({ type: "file", size: 10, mtime: 2 });
        if (change === "identity")
          context.getAbstractFileByPath.mockReturnValue(Object.assign(new TFile(), context.source));
        if (change === "path") context.source.path = "assets/renamed.png";
        return { success: true, url: "https://cdn.example/a.png" };
      });
      await context.process();
      expect(context.trashFile).not.toHaveBeenCalled();
    },
  );

  test("rechecks editors after the final asynchronous stat", async () => {
    const context = deletionFixture();
    context.stat.mockImplementationOnce(async () => ({ type: "file", size: 10, mtime: 1 }));
    context.stat.mockImplementationOnce(async () => {
      context.root.editor.setValue("![[assets/a.png]]");
      return { type: "file", size: 10, mtime: 1 };
    });
    await context.process();
    expect(context.trashFile).not.toHaveBeenCalled();
  });

  test.each([1, 2])("stat failure on call %s preserves the source", async (call) => {
    const context = deletionFixture();
    if (call === 2) context.stat.mockResolvedValueOnce({ type: "file", size: 10, mtime: 1 });
    context.stat.mockRejectedValueOnce(new Error("stat failed"));
    await expect(context.process()).resolves.toBe("succeeded");
    expect(context.trashFile).not.toHaveBeenCalled();
  });
});

describe("upload and editor replacement", () => {
  test("does not modify a view that switched to another note during upload", async () => {
    const { app, root } = fixture();
    const attachment = new AttachmentMatcher(app).getEditorAttachments(root as never)[0]!;
    const service = createLocalAttachments("", false, new Set([".png"]));
    vi.spyOn(service, "uploadFile").mockImplementationOnce(async () => {
      root.file = { path: "another.md" } as TFile;
      return { success: true, url: "https://cdn.example/a.png" };
    });
    await service.processAttachment(attachment, root as never, app);
    expect(root.editor.transaction).not.toHaveBeenCalled();
    expect(preserveUploadReceipt).toHaveBeenCalledExactlyOnceWith(
      "https://cdn.example/a.png",
      attachment.inSystemPath,
      attachment.basename,
    );
  });
  test.each(["removed", "exception"])("receipts a manual upload after %s", async (failure) => {
    const context = deletionFixture();
    context.upload.mockImplementation(async () => {
      if (failure === "removed") context.root.editor.setValue("removed");
      else
        context.root.editor.transaction.mockImplementation(() => {
          throw new Error("editor unavailable");
        });
      return { success: true, url: "https://cdn.example/a.png" };
    });
    await expect(context.process()).resolves.toBe("notApplied");
    expect(preserveUploadReceipt).toHaveBeenCalledExactlyOnceWith(
      "https://cdn.example/a.png",
      "/vault/assets/a.png",
      "a.png",
    );
    expect(context.trashFile).not.toHaveBeenCalled();
  });
  test("shares an in-flight command across service instances", async () => {
    let finish!: (url: string) => void;
    vi.mocked(executeUploadCommand).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const uploader = new Uploader(executeUploadCommand);
    const first = createLocalAttachments("uploader %s", false, new Set(), uploader);
    const second = createLocalAttachments("uploader %s", false, new Set(), uploader);
    const one = first.uploadFile("/vault/a.png");
    const two = second.uploadFile("/vault/a.png");
    expect(executeUploadCommand).toHaveBeenCalledTimes(1);
    finish("https://cdn.example/a.png");
    expect(await one).toEqual(await two);
  });

  test("uploads one file and rewrites its variants without changing code examples", async () => {
    const { app, root } = fixture();
    const source = "![[assets/a.png]]";
    root.editor.setValue(`\`${source}\`\n${source}\n![](assets/a.png)`);
    const service = createLocalAttachments("", false, new Set([".png"]));
    const upload = vi
      .spyOn(service, "uploadFile")
      .mockResolvedValue({ success: true, url: "https://cdn.example/a.png" });
    const attachments = new AttachmentMatcher(app).getEditorAttachments(root as never);
    for (const attachment of attachments) await service.processAttachment(attachment, root, app);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(root.editor.getValue()).toBe(
      `\`${source}\`\n![a.png](https://cdn.example/a.png)\n![a.png](https://cdn.example/a.png)`,
    );
  });

  test("escapes filename characters that would break Markdown labels", () => {
    expect(formatUploadedFile("a[b].png", "https://cdn.example/a.png")).toBe(
      "![a\\[b\\].png](https://cdn.example/a.png)",
    );
  });

  test("manual upload preserves image embedding through the matcher pipeline", async () => {
    const { app, root } = fixture();
    const attachment = new AttachmentMatcher(app).getEditorAttachments(root as never)[0]!;
    const service = createLocalAttachments("", false, new Set([".png"]));
    vi.spyOn(service, "uploadFile").mockResolvedValue({
      success: true,
      url: "https://cdn.example/a.png",
    });
    await service.processAttachment(attachment, root, app);
    expect(root.editor.getValue()).toBe("![a.png](https://cdn.example/a.png)");
  });
});

test("cancelling an already-running local upload preserves the cloud result without replacing or deleting", async () => {
  const { app, root } = fixture();
  const attachment = new AttachmentMatcher(app).getEditorAttachments(root)[0]!;
  const controller = new AbortController();
  const service = createLocalAttachments("uploader %s", true, new Set([".png"]));
  vi.spyOn(service, "uploadFile").mockImplementation(async () => {
    controller.abort();
    return { success: true, url: "https://cdn.example/new.png" };
  });
  const status = await service.processAttachment(attachment, root, app, controller.signal);
  expect(status).toBe("notApplied");
  expect(root.editor.getValue()).toBe("![[assets/a.png]]");
  expect(preserveUploadReceipt).toHaveBeenCalledExactlyOnceWith(
    "https://cdn.example/new.png",
    attachment.inSystemPath,
    attachment.basename,
  );
});
