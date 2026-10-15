import type { App, EditorTransaction, TFile } from "obsidian";
import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path,
  Notice: class {},
  TFile: class {},
}));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));

import { AttachmentMatcher } from "../src/attachmentMatcher";
import { executeUploadCommand } from "../src/services/command";
import { UploadService } from "../src/services/uploadService";

vi.mock("../src/services/command", () => ({
  executeUploadCommand: vi.fn<typeof executeUploadCommand>(),
}));

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

describe("upload and editor replacement", () => {
  test("does not modify a view that switched to another note during upload", async () => {
    const { app, root } = fixture();
    const attachment = new AttachmentMatcher(app).getEditorAttachments(root as never)[0]!;
    const service = new UploadService("", false, new Set([".png"]));
    vi.spyOn(service, "uploadServe").mockImplementationOnce(async () => {
      root.file = { path: "another.md" } as TFile;
      return { success: true, url: "https://cdn.example/a.png" };
    });
    await service.processAttachment(attachment, root as never, app);
    expect(root.editor.transaction).not.toHaveBeenCalled();
  });
  test("shares an in-flight command across service instances", async () => {
    let finish!: (url: string) => void;
    vi.mocked(executeUploadCommand).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const tasks = new Map();
    const first = new UploadService("uploader %s", false, new Set(), tasks);
    const second = new UploadService("uploader %s", false, new Set(), tasks);
    const one = first.uploadServe("/vault/a.png");
    const two = second.uploadServe("/vault/a.png");
    expect(executeUploadCommand).toHaveBeenCalledTimes(1);
    finish("https://cdn.example/a.png");
    expect(await one).toEqual(await two);
    expect(tasks.size).toBe(0);
  });

  test("uploads one file and rewrites its variants without changing code examples", async () => {
    const { app, root } = fixture();
    const source = "![[assets/a.png]]";
    root.editor.setValue(`\`${source}\`\n${source}\n![](assets/a.png)`);
    const service = new UploadService("", false, new Set([".png"]));
    const upload = vi
      .spyOn(service, "uploadServe")
      .mockResolvedValue({ success: true, url: "https://cdn.example/a.png" });
    const attachments = new AttachmentMatcher(app).getEditorAttachments(root as never);
    for (const attachment of attachments) await service.processAttachment(attachment, root, app);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(root.editor.getValue()).toBe(
      `\`${source}\`\n![a.png](https://cdn.example/a.png)\n![a.png](https://cdn.example/a.png)`,
    );
  });

  test("escapes filename characters that would break Markdown labels", () => {
    const service = new UploadService("", false, new Set([".png"]));
    expect(service.formatUploadedFile("a[b].png", "https://cdn.example/a.png")).toBe(
      "![a\\[b\\].png](https://cdn.example/a.png)",
    );
  });

  test("manual upload preserves image embedding through the matcher pipeline", async () => {
    const { app, root } = fixture();
    const attachment = new AttachmentMatcher(app).getEditorAttachments(root as never)[0]!;
    const service = new UploadService("", false, new Set([".png"]));
    vi.spyOn(service, "uploadServe").mockResolvedValue({
      success: true,
      url: "https://cdn.example/a.png",
    });
    await service.processAttachment(attachment, root, app);
    expect(root.editor.getValue()).toBe("![a.png](https://cdn.example/a.png)");
  });

  test("auto replacement respects each note's resolved attachment identity", async () => {
    const { app, files, root, nested } = fixture();
    const service = new UploadService("", false, new Set([".png"]));
    const count = await service.replaceLocalLinksInAllEditors(
      app,
      files[0] as TFile,
      "https://cdn.example/root.png",
    );
    expect(count).toBe(1);
    expect(root.editor.getValue()).toBe("![a.png](https://cdn.example/root.png)");
    expect(nested.editor.getValue()).toBe("![](assets/a.png)");
  });

  test("leaves unresolved references untouched even when the basename exists", async () => {
    const { app, files, root } = fixture();
    root.editor.setValue("![](missing/a.png)");
    const service = new UploadService("", false, new Set([".png"]));
    expect(
      await service.replaceLocalLinksInAllEditors(
        app,
        files[0] as TFile,
        "https://cdn.example/a.png",
      ),
    ).toBe(0);
    expect(root.editor.getValue()).toBe("![](missing/a.png)");
  });
});
