import { expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", async () => {
  const { StateField } = await import("@codemirror/state");
  const element = (): Record<string, unknown> => ({
    disabled: false,
    addEventListener: vi.fn<() => void>(),
    setAttribute: vi.fn<() => void>(),
    createEl: vi.fn<() => Record<string, unknown>>(() => element()),
  });
  class Notice {
    static instances: Notice[] = [];
    message: string | DocumentFragment;
    messageEl = element();
    constructor(message: string | DocumentFragment) {
      this.message = message;
      Notice.instances.push(this);
    }
    setMessage(message: string | DocumentFragment) {
      this.message = message;
      return this;
    }
    hide() {}
  }
  return {
    editorInfoField: StateField.define({ create: () => null, update: (value) => value }),
    Plugin: class {},
    Notice,
    TFile: class {},
    normalizePath: (path: string) => path,
  };
});
vi.mock("../src/upload/uploader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/upload/uploader")>()),
  executeUploadCommand: vi.fn<(command: string, path: string) => Promise<string>>(
    async () => "https://uploaded.example/a.png",
  ),
}));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));
vi.mock("../src/settingsTab", () => ({ SettingTab: class {} }));

import { EditorState } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { editorInfoField, Notice } from "obsidian";
import type { Editor } from "obsidian";

import { AttachmentMatcher } from "../src/attachments/vaultAttachments";
import { parseSettings } from "../src/settings";
import { RemoteImageDownloader } from "../src/upload/imageDownloader";
import { LocalAttachments } from "../src/upload/localAttachments";
import type { RemoteImageScope } from "../src/upload/remoteImages";
import { Uploader } from "../src/upload/uploader";
import { executeUploadCommand } from "../src/upload/uploader";
import { UploadWorkflow } from "../src/uploadWorkflow";

function fullSettings() {
  return {
    uploadService: "uPic" as const,
    uploadCommand: "/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s",
    uploadFileFormat: new Set([".png"]),
    isDeleteSourceFile: false,
    autoUpload: true,
    autoTransferRemoteImages: true,
    remoteImageSkipPrefixes: [] as string[],
  };
}

function fakeEditor(initial = "") {
  let content = initial;
  return {
    getValue: () => content,
    getCursor: () => ({ line: 0, ch: content.length }),
    getSelection: () => "",
    getRange: () => "",
    posToOffset: (position: { ch: number }) => position.ch,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    replaceSelection: (text: string) => {
      content += text;
    },
    transaction: vi.fn<() => void>(),
  } as unknown as Editor & { getValue(): string };
}

function clipboard(text: string, html = "") {
  return {
    items: [] as Array<{ kind: string }>,
    getData: (type: string) => {
      if (type === "text/plain") return text;
      if (type === "text/html") return html;
      return "";
    },
  };
}

function eventData(text: string, html = "") {
  let prevented = false;
  return {
    clipboardData: clipboard(text, html),
    get defaultPrevented() {
      return prevented;
    },
    preventDefault: () => {
      prevented = true;
    },
  };
}

function createPlugin(overrides: Partial<ReturnType<typeof fullSettings>> = {}) {
  const plugin = new UploadWorkflow(
    {} as never,
    parseSettings(null),
    new Uploader(executeUploadCommand),
  );
  plugin.settings = { ...fullSettings(), ...overrides };
  const start = vi.fn<(...args: unknown[]) => Promise<ReturnType<typeof summary> | null>>(
    async () => null,
  );
  (plugin as unknown as { startRemoteTransfer: typeof start }).startRemoteTransfer = start;
  return { plugin, start };
}

async function paste(
  plugin: UploadWorkflow,
  text: string,
  options: { html?: string; editor?: ReturnType<typeof fakeEditor> } = {},
) {
  const editor = options.editor ?? fakeEditor();
  const event = eventData(text, options.html);
  await (
    plugin as unknown as {
      handlePaste: (
        event: ClipboardEvent,
        editor: Editor,
        info: { file: { path: string } },
      ) => Promise<void>;
    }
  ).handlePaste(event as unknown as ClipboardEvent, editor, {
    file: { path: "note.md" },
  });
  return { editor, event };
}

test("leaves plain Markdown alone when the paste policy is off", async () => {
  const { plugin, start } = createPlugin({ autoTransferRemoteImages: false });
  const { event, editor } = await paste(plugin, "![](https://cdn.example/a.png)");
  expect(event.defaultPrevented).toBe(false);
  expect(editor.getValue()).toBe("");
  expect(start).not.toHaveBeenCalled();
});

test("starts the transfer automatically while keeping the pasted range", async () => {
  const { plugin, start } = createPlugin({ autoTransferRemoteImages: true });
  const text = "![](https://cdn.example/a.png)";
  const { event, editor } = await paste(plugin, text);
  expect(event.defaultPrevented).toBe(true);
  expect(editor.getValue()).toBe(text);
  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0]![1]).toMatchObject({
    kind: "paste",
    start: 0,
    end: text.length,
    anchorText: text,
  });
});

test("does not intercept rich clipboard content", async () => {
  const { plugin, start } = createPlugin({ autoTransferRemoteImages: true });
  const { event } = await paste(plugin, "![](https://cdn.example/a.png)", {
    html: "<p>rich</p>",
  });
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

test("does not intercept text without supported remote images", async () => {
  const { plugin, start } = createPlugin({ autoTransferRemoteImages: true });
  const { event } = await paste(plugin, "plain text and [a link](https://cdn.example/a.png)");
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

test("does not intercept when every image is already covered by a configured prefix", async () => {
  const { plugin, start } = createPlugin({
    autoTransferRemoteImages: true,
    remoteImageSkipPrefixes: ["https://cdn.example/"],
  });
  const { event } = await paste(plugin, "![](https://cdn.example/a.png)");
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

function summary() {
  return {
    totalReferences: 1,
    uniqueUrls: 1,
    skipped: 0,
    succeeded: 1,
    failed: 0,
    notApplied: 0,
    cancelled: false,
    limitExceeded: false,
    errors: [],
  };
}

test("shares an in-flight transfer for the same note and captured content", async () => {
  const plugin = new UploadWorkflow(
    {} as never,
    parseSettings(null),
    new Uploader(executeUploadCommand),
  );
  plugin.settings = fullSettings() as never;
  const pending: Array<(value: ReturnType<typeof summary>) => void> = [];
  const execute = vi.fn<() => Promise<ReturnType<typeof summary>>>(
    () =>
      new Promise<ReturnType<typeof summary>>((resolve) => {
        pending.push(resolve);
      }),
  );
  (plugin as unknown as { executeRemoteImageTransfer: typeof execute }).executeRemoteImageTransfer =
    execute;
  const view = { file: { path: "note.md" } } as never;
  const start = (
    plugin as unknown as {
      startRemoteTransfer: (
        path: string,
        scope: { kind: "note" },
        view: never,
      ) => Promise<ReturnType<typeof summary> | null>;
    }
  ).startRemoteTransfer.bind(plugin);

  const first = start("note.md", { kind: "note" }, view);
  const second = start("note.md", { kind: "note" }, view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(execute).toHaveBeenCalledOnce();
  pending[0]!(summary());
  await expect(first).resolves.toMatchObject({ succeeded: 1 });
  await expect(second).resolves.toMatchObject({ succeeded: 1 });
});

test("serializes different transfers on the same note", async () => {
  const plugin = new UploadWorkflow(
    {} as never,
    parseSettings(null),
    new Uploader(executeUploadCommand),
  );
  plugin.settings = fullSettings() as never;
  const started: number[] = [];
  let release!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn<() => Promise<ReturnType<typeof summary>>>(async () => {
    started.push(started.length);
    if (started.length === 1) await firstGate;
    return summary();
  });
  (plugin as unknown as { executeRemoteImageTransfer: typeof execute }).executeRemoteImageTransfer =
    execute;
  const view = { file: { path: "note.md" } } as never;
  const start = (
    plugin as unknown as {
      startRemoteTransfer: (
        path: string,
        scope: { kind: "note" } | { kind: "paste"; start: number; end: number },
        view: never,
      ) => Promise<unknown>;
    }
  ).startRemoteTransfer.bind(plugin);

  const first = start("note.md", { kind: "note" }, view);
  const second = start("note.md", { kind: "paste", start: 0, end: 1 }, view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toHaveLength(1);
  release();
  await Promise.all([first, second]);
  expect(started).toHaveLength(2);
});

test("never writes into a view that switched notes and falls back to the source file", async () => {
  const plugin = new UploadWorkflow(
    {} as never,
    parseSettings(null),
    new Uploader(executeUploadCommand),
  );
  plugin.settings = fullSettings() as never;
  let content = "original";
  const otherEditor = fakeEditor("other note");
  const otherView = { file: { path: "other.md" }, editor: otherEditor };
  const noteFile = { path: "note.md" };
  const read = vi.fn<() => Promise<string>>(async () => content);
  const process = vi.fn<(file: unknown, transform: (value: string) => string) => Promise<string>>(
    async (_file, transform) => {
      content = transform(content);
      return content;
    },
  );
  plugin.app = {
    workspace: {
      getLeavesOfType: () => [{ isDeferred: false, view: otherView }],
    },
    vault: {
      getFileByPath: (path: string) => (path === "note.md" ? noteFile : null),
      read,
      process,
    },
  } as never;
  const capturedView = {
    file: { path: "note.md" },
    editor: fakeEditor("stale source"),
  };
  const documentAccess = (
    plugin as unknown as {
      createRemoteDocument: (
        path: string,
        view: unknown,
      ) => {
        read: () => Promise<{ content: string; live: boolean } | null>;
        apply: (
          content: string,
          changes: Array<{ start: number; end: number; text: string }>,
        ) => Promise<boolean>;
      };
    }
  ).createRemoteDocument("note.md", capturedView);

  capturedView.file = { path: "other.md" };
  expect(await documentAccess.read()).toEqual({ content: "original", live: false });
  expect(await documentAccess.apply("original", [{ start: 0, end: 8, text: "changed" }])).toBe(
    true,
  );
  expect(process).toHaveBeenCalledOnce();
  expect(otherEditor.transaction).not.toHaveBeenCalled();
  expect(content).toBe("changed");

  content = "edited externally";
  expect(await documentAccess.apply("changed", [{ start: 0, end: 7, text: "nope" }])).toBe(false);
  expect(content).toBe("edited externally");
});

test("uses the vault path instead of the reading-view editor", async () => {
  const plugin = new UploadWorkflow(
    {} as never,
    parseSettings(null),
    new Uploader(executeUploadCommand),
  );
  plugin.settings = fullSettings() as never;
  let content = "original";
  const previewEditor = fakeEditor("stale preview");
  const previewView = {
    file: { path: "note.md" },
    editor: previewEditor,
    getMode: () => "preview",
  };
  const noteFile = { path: "note.md" };
  const process = vi.fn<(file: unknown, transform: (value: string) => string) => Promise<string>>(
    async (_file, transform) => {
      content = transform(content);
      return content;
    },
  );
  plugin.app = {
    workspace: { getLeavesOfType: () => [{ isDeferred: false, view: previewView }] },
    vault: {
      getFileByPath: (path: string) => (path === "note.md" ? noteFile : null),
      read: async () => content,
      process,
    },
  } as never;
  const documentAccess = (
    plugin as unknown as {
      createRemoteDocument: (
        path: string,
        view: unknown,
      ) => {
        read: () => Promise<{ content: string; live: boolean } | null>;
        apply: (
          content: string,
          changes: Array<{ start: number; end: number; text: string }>,
        ) => Promise<boolean>;
      };
    }
  ).createRemoteDocument("note.md", previewView);

  expect(await documentAccess.read()).toEqual({ content: "original", live: false });
  expect(await documentAccess.apply("original", [{ start: 0, end: 8, text: "changed" }])).toBe(
    true,
  );
  expect(process).toHaveBeenCalledOnce();
  expect(previewEditor.transaction).not.toHaveBeenCalled();
});

test("resolves an unresolved reference against a definition already in the note", async () => {
  const { plugin, start } = createPlugin({ autoTransferRemoteImages: true });
  const definition = "[photo]: https://cdn.example/a.png\n\n";
  const editor = fakeEditor(definition);
  const text = "![a][photo]";
  const { event } = await paste(plugin, text, { editor });
  expect(event.defaultPrevented).toBe(true);
  expect(editor.getValue()).toBe(definition + text);
  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0]![1]).toMatchObject({
    kind: "paste",
    start: definition.length,
    end: definition.length + text.length,
  });
});

test("handles mixed local and externally defined remote images", async () => {
  const { plugin, start } = createPlugin();
  const editor = fakeEditor("[remote]: https://cdn.example/a.png\n\n");
  const { event } = await paste(plugin, "![local](assets/local.png)\n![remote][remote]", {
    editor,
  });
  expect(event.defaultPrevented).toBe(true);
  expect(start).toHaveBeenCalledOnce();
});

test("leaves mixed local images and an undefined reference to Obsidian", async () => {
  const { plugin, start } = createPlugin({ autoTransferRemoteImages: true });
  const { event } = await paste(plugin, "![local](assets/local.png)\n![remote][missing]");
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

test("leaves a pasted fragment with only local reference images to Obsidian", async () => {
  const { plugin, start } = createPlugin({ autoTransferRemoteImages: true });
  const text = "![a][local]\n\n[local]: assets/a.png";
  const { event } = await paste(plugin, text);
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

interface TargetSnapshot {
  generation: number;
  outputs: Set<string>;
  upload(path: string): Promise<{ success: boolean; url?: string }>;
}

function targetAccess(plugin: UploadWorkflow) {
  return plugin as unknown as {
    captureRemoteTarget(): TargetSnapshot;
    remoteOutputUrls: Set<string>;
  };
}

test("switching target replaces session records, rejects late writes and preserves manual rules", async () => {
  const plugin = new UploadWorkflow(
    {} as never,
    parseSettings(null),
    new Uploader(executeUploadCommand),
  );
  plugin.settings = fullSettings() as never;
  const access = targetAccess(plugin);
  plugin.settings.remoteImageSkipPrefixes = ["https://manual.example/"];
  const old = access.captureRemoteTarget();
  old.outputs.add("https://old.example/one.png");
  plugin.settings.uploadCommand = "new-uploader %s";
  const current = access.captureRemoteTarget();
  old.outputs.add("https://old.example/late.png");
  expect(current.outputs.size).toBe(0);
  expect(current.outputs).not.toBe(old.outputs);
  expect(current.generation).toBeGreaterThan(old.generation);
  expect(plugin.settings.remoteImageSkipPrefixes).toEqual(["https://manual.example/"]);
  // Switching back also starts a fresh generation; an older A job isn't current.
  plugin.settings.uploadCommand = fullSettings().uploadCommand;
  expect(access.captureRemoteTarget().outputs.size).toBe(0);
  expect(access.captureRemoteTarget().generation).toBeGreaterThan(current.generation);
});

test("queued operations freeze their upload command before settings change", async () => {
  const plugin = new UploadWorkflow(
    {} as never,
    parseSettings(null),
    new Uploader(executeUploadCommand),
  );
  plugin.settings = fullSettings() as never;
  const original = plugin.settings.uploadCommand;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const targets: TargetSnapshot[] = [];
  const execute = async (
    _path: string,
    _scope: unknown,
    _view: unknown,
    _controller: unknown,
    target: TargetSnapshot,
  ) => {
    targets.push(target);
    if (targets.length === 1) await gate;
    return summary();
  };
  const access = plugin as unknown as {
    executeRemoteImageTransfer: typeof execute;
    startRemoteTransfer(
      path: string,
      scope: { kind: string; start?: number; end?: number },
      view: unknown,
    ): Promise<unknown>;
  };
  access.executeRemoteImageTransfer = execute;
  const view = { file: { path: "note.md" } };
  const first = access.startRemoteTransfer("note.md", { kind: "note" }, view);
  const queued = access.startRemoteTransfer("note.md", { kind: "paste", start: 0, end: 2 }, view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  plugin.settings.uploadCommand = "new-uploader %s";
  const next = access.startRemoteTransfer("note.md", { kind: "note" }, view);
  finish();
  await Promise.all([first, queued, next]);
  vi.mocked(executeUploadCommand).mockClear();
  for (const target of targets) await target.upload("/frozen.png");
  expect(vi.mocked(executeUploadCommand).mock.calls.map(([command]) => command)).toEqual([
    original,
    original,
    "new-uploader %s",
  ]);
});

test("the editor hook maps captured references and rejects a file switch even without text changes", () => {
  const plugin = new UploadWorkflow(
    {} as never,
    parseSettings(null),
    new Uploader(executeUploadCommand),
  );
  const anchor = "![](https://cdn.example/a.png)";
  const editor = fakeEditor(anchor);
  const view = { file: { path: "note.md" }, editor };
  const scope: RemoteImageScope = { kind: "note" };
  const access = plugin as unknown as {
    captureReferenceScope(scope: RemoteImageScope, view: unknown): void;
    updateEditor(update: ViewUpdate): void;
  };
  access.captureReferenceScope(scope, view);
  const state = EditorState.create({
    doc: anchor,
    extensions: [editorInfoField.init(() => view as never)],
  });
  const transaction = state.update({ changes: { from: 0, insert: "prefix\n" } });
  access.updateEditor({
    startState: state,
    state: transaction.state,
    docChanged: true,
    transactions: [transaction],
  } as unknown as ViewUpdate);
  expect(scope.tracker!.references(transaction.newDoc.toString())[0]?.start).toBe(7);
  view.file = { path: "other.md" };
  access.updateEditor({
    startState: transaction.state,
    state: transaction.state,
    docChanged: false,
    transactions: [],
  } as unknown as ViewUpdate);
  view.file = { path: "note.md" };
  expect(scope.tracker!.references(transaction.newDoc.toString())).toEqual([]);
});

test("different notes upload separately through one command queue", async () => {
  let downloads = 0;
  let running = 0;
  let peak = 0;
  const download = vi
    .spyOn(RemoteImageDownloader.prototype, "download")
    .mockImplementation(async () => ({
      path: `/fake/${++downloads}.png`,
      extension: "png",
      bytes: 1,
    }));
  const upload = vi.fn<(command: string, path: string) => Promise<string>>(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running--;
    return "https://new.example/a.png";
  });
  const plugin = new UploadWorkflow(
    { workspace: { getLeavesOfType: () => [] } } as never,
    fullSettings(),
    new Uploader(upload),
  );
  const access = plugin as unknown as {
    startRemoteTransfer(path: string, scope: RemoteImageScope, view: unknown): Promise<unknown>;
  };
  try {
    await Promise.all(
      ["A.md", "B.md"].map((path) =>
        access.startRemoteTransfer(
          path,
          { kind: "note" },
          {
            file: { path },
            editor: fakeEditor("![](https://source.example/a.png)"),
          },
        ),
      ),
    );
    expect(downloads).toBe(2);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  } finally {
    download.mockRestore();
  }
});

test("an old running transfer cannot restore session URLs after target switch", async () => {
  const plugin = new UploadWorkflow(
    {} as never,
    parseSettings(null),
    new Uploader(executeUploadCommand),
  );
  plugin.settings = fullSettings() as never;
  plugin.app = { workspace: { getLeavesOfType: () => [] } } as never;
  let finish!: (value: { success: boolean; url: string }) => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    started = resolve;
  });
  const download = vi.spyOn(RemoteImageDownloader.prototype, "download").mockResolvedValue({
    path: "/fake/a.png",
    extension: "png",
    bytes: 1,
  });
  const upload = vi.spyOn(Uploader.prototype, "uploadFile").mockImplementation(async () => {
    started();
    return await new Promise((resolve) => {
      finish = resolve;
    });
  });
  const access = plugin as unknown as {
    startRemoteTransfer(path: string, scope: RemoteImageScope, view: unknown): Promise<unknown>;
  };
  try {
    const operation = access.startRemoteTransfer(
      "A.md",
      { kind: "note" },
      {
        file: { path: "A.md" },
        editor: fakeEditor("![](https://source.example/a.png)"),
      },
    );
    await gate;
    plugin.settings.uploadCommand = "new-target %s";
    const next = targetAccess(plugin).captureRemoteTarget();
    finish({ success: true, url: "https://old.example/late.png" });
    await operation;
    expect(next.outputs.size).toBe(0);
  } finally {
    download.mockRestore();
    upload.mockRestore();
  }
});

test("leaves previously uploaded session results to the normal paste handler", async () => {
  const { plugin, start } = createPlugin();
  targetAccess(plugin).captureRemoteTarget().outputs.add("https://cdn.example/already.png");
  const { event } = await paste(plugin, "![](https://cdn.example/already.png)");
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

async function runManualUpload(plugin: UploadWorkflow) {
  await (plugin as unknown as { uploadCurrentNote(): Promise<void> }).uploadCurrentNote();
}

test.each([
  { name: "local-only", remote: false, local: true },
  { name: "remote-only", remote: true, local: false },
  { name: "mixed", remote: true, local: true },
])(
  "the unified manual action handles $name notes even with automatic transfer disabled",
  async ({ remote, local }) => {
    const { plugin, start } = createPlugin({ autoUpload: false, autoTransferRemoteImages: false });
    const editor = fakeEditor(remote ? "![](https://source.example/a.png)" : "![](local.png)");
    const view = { file: { path: "note.md" }, editor };
    plugin.app = { workspace: { activeEditor: view } } as never;
    const attachments = local ? [{ inVaultPath: "local.png" }] : [];
    const order: string[] = [];
    start.mockImplementation(async () => {
      order.push("remote");
      return summary();
    });
    const matcher = vi
      .spyOn(AttachmentMatcher.prototype, "getEditorAttachments")
      .mockReturnValue([]);
    const filter = vi
      .spyOn(LocalAttachments.prototype, "filterUploadableAttachments")
      .mockReturnValue(attachments as never);
    const upload = vi
      .spyOn(LocalAttachments.prototype, "processAttachment")
      .mockImplementation(async () => {
        order.push("local");
        editor.replaceSelection("![](https://uploaded.example/local.png)");
        return "succeeded";
      });
    const before = noticeMessages().length;
    try {
      await runManualUpload(plugin);
      expect(noticeMessages().slice(before)).toEqual([
        "Uploading attachments...",
        `Uploaded: ${Number(remote) + Number(local)} · Failed: 0 · Skipped: 0`,
      ]);
      expect(start).toHaveBeenCalledTimes(remote ? 1 : 0);
      expect(start.mock.calls.map((call) => call.slice(0, 3))).toEqual(
        remote ? [["note.md", { kind: "note" }, view]] : [],
      );
      expect(upload).toHaveBeenCalledTimes(local ? 1 : 0);
      expect(order).toEqual([...(remote ? ["remote"] : []), ...(local ? ["local"] : [])]);
    } finally {
      matcher.mockRestore();
      filter.mockRestore();
      upload.mockRestore();
    }
  },
);

test("switching notes during remote transfer stops the local phase", async () => {
  const { plugin, start } = createPlugin();
  const view = {
    file: { path: "note.md" },
    editor: fakeEditor("![](https://source.example/a.png)"),
  };
  plugin.app = { workspace: { activeEditor: view } } as never;
  start.mockImplementation(async () => {
    view.file = { path: "other.md" };
    return null;
  });
  const matcher = vi.spyOn(AttachmentMatcher.prototype, "getEditorAttachments");
  try {
    await runManualUpload(plugin);
    expect(start).toHaveBeenCalledOnce();
    expect(matcher).not.toHaveBeenCalled();
  } finally {
    matcher.mockRestore();
  }
});

function noticeMessages(): Array<string | DocumentFragment> {
  return (
    Notice as unknown as { instances: Array<{ message: string | DocumentFragment }> }
  ).instances.map((notice) => notice.message);
}

test.each([false, true])(
  "the main auto-upload switch gates file paste and drop when %s",
  async (enabled) => {
    const { plugin } = createPlugin({ autoUpload: enabled });
    const insertion = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
    plugin.fileInsertion.handle = insertion;
    const editor = fakeEditor();
    const info = { file: { path: "note.md" } };
    const file = { name: "a.png" };
    const event = {
      defaultPrevented: false,
      clipboardData: { items: [{ kind: "file", getAsFile: () => file }] },
    };
    const access = plugin as unknown as {
      handlePaste(event: unknown, editor: Editor, info: unknown): Promise<void>;
      handleDrop(event: unknown, editor: Editor, info: unknown): Promise<void>;
    };
    await access.handlePaste(event, editor, info);
    await access.handleDrop({ dataTransfer: { files: [file] } }, editor, info);
    expect(insertion).toHaveBeenCalledTimes(enabled ? 2 : 0);
  },
);

test("disabling automatic uploads also gates remote images while retaining their option", async () => {
  const { plugin, start } = createPlugin({ autoUpload: false, autoTransferRemoteImages: true });
  const { event } = await paste(plugin, "![](https://source.example/a.png)");
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
  expect(plugin.settings.autoTransferRemoteImages).toBe(true);
});

test("cancel during remote transfer prevents the local phase and reports one final result", async () => {
  const { plugin, start } = createPlugin();
  const view = {
    file: { path: "note.md" },
    editor: fakeEditor("![](https://source.example/a.png)"),
  };
  plugin.app = { workspace: { activeEditor: view } } as never;
  start.mockImplementation(async (...args) => {
    (args[3] as { controller: AbortController }).controller.abort();
    return { ...summary(), succeeded: 0, cancelled: true };
  });
  const matcher = vi.spyOn(AttachmentMatcher.prototype, "getEditorAttachments");
  const before = noticeMessages().length;
  try {
    await runManualUpload(plugin);
    expect(matcher).not.toHaveBeenCalled();
    expect(noticeMessages().slice(before)).toEqual([
      "Uploading attachments...",
      "Uploaded: 0 · Failed: 0 · Skipped: 0 · Upload cancelled.",
    ]);
  } finally {
    matcher.mockRestore();
  }
});

test("cancel during a local upload preserves its unapplied result and prevents the next upload", async () => {
  const { plugin } = createPlugin();
  plugin.app = {
    workspace: {
      activeEditor: { file: { path: "note.md" }, editor: fakeEditor("![](a.png) ![](b.png)") },
    },
  } as never;
  const matcher = vi.spyOn(AttachmentMatcher.prototype, "getEditorAttachments").mockReturnValue([]);
  const filter = vi
    .spyOn(LocalAttachments.prototype, "filterUploadableAttachments")
    .mockReturnValue([{ inVaultPath: "a.png" }, { inVaultPath: "b.png" }] as never);
  let controller: AbortController | undefined;
  const progress = vi
    .spyOn(
      plugin as unknown as {
        createUploadProgress(controller: AbortController): { update(): void; close(): void };
      },
      "createUploadProgress",
    )
    .mockImplementation((value) => {
      controller = value;
      return { update: () => {}, close: () => {} };
    });
  const upload = vi
    .spyOn(LocalAttachments.prototype, "processAttachment")
    .mockImplementation(async () => {
      controller!.abort();
      return "notApplied";
    });
  const before = noticeMessages().length;
  try {
    await runManualUpload(plugin);
    expect(upload).toHaveBeenCalledOnce();
    expect(noticeMessages().slice(before)).toEqual([
      "Uploaded: 0 · Failed: 0 · Skipped: 0 · Not applied: 1 · Upload cancelled.",
    ]);
  } finally {
    matcher.mockRestore();
    filter.mockRestore();
    progress.mockRestore();
    upload.mockRestore();
  }
});

test("repeated manual clicks share the entire note upload task", async () => {
  const { plugin, start } = createPlugin();
  plugin.app = {
    workspace: {
      activeEditor: {
        file: { path: "note.md" },
        editor: fakeEditor("![](https://source.example/a.png)"),
      },
    },
  } as never;
  let finish!: (value: ReturnType<typeof summary>) => void;
  start.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const matcher = vi.spyOn(AttachmentMatcher.prototype, "getEditorAttachments").mockReturnValue([]);
  const before = noticeMessages().length;
  try {
    const first = runManualUpload(plugin);
    const second = runManualUpload(plugin);
    expect(start).toHaveBeenCalledOnce();
    finish(summary());
    await Promise.all([first, second]);
    expect(matcher).toHaveBeenCalledOnce();
    expect(noticeMessages().slice(before)).toEqual([
      "Uploading attachments...",
      "Uploaded: 1 · Failed: 0 · Skipped: 0",
    ]);
  } finally {
    matcher.mockRestore();
  }
});

test("successful local uploads are remembered so their URLs are not transferred again", async () => {
  const { plugin, start } = createPlugin();
  vi.mocked(executeUploadCommand).mockResolvedValueOnce("https://uploaded.example/local.png");
  await expect(plugin.uploadFile("/local.png")).resolves.toMatchObject({ success: true });
  const { event } = await paste(plugin, "![](https://uploaded.example/local.png)");
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

test("late local uploads keep their session records isolated after a tool change", async () => {
  const { plugin } = createPlugin();
  let finish!: (url: string) => void;
  vi.mocked(executeUploadCommand).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const operation = plugin.uploadFile("/local.png");
  plugin.settings.uploadCommand = "new-tool %s";
  const next = targetAccess(plugin).captureRemoteTarget();
  finish("https://old.example/local.png");
  await operation;
  expect(next.outputs.size).toBe(0);
});

test("local, remote and inserted files share the workflow's uploader", async () => {
  let finish!: (stdout: string) => void;
  const execute = vi
    .fn<(command: string, path: string) => Promise<string>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue("https://cdn.example/result.png");
  const workflow = new UploadWorkflow({} as never, fullSettings(), new Uploader(execute));
  const local = workflow.localAttachments.uploadFile("/local.png");
  const remote = targetAccess(workflow).captureRemoteTarget().upload("/remote.png");
  const pasted = workflow.fileInsertion.uploadFile("/pasted.png");
  expect(execute.mock.calls.map((call) => call[1])).toEqual(["/local.png"]);
  finish("https://cdn.example/local.png");
  await Promise.all([local, remote, pasted]);
  expect(execute.mock.calls.map((call) => call[1])).toEqual([
    "/local.png",
    "/remote.png",
    "/pasted.png",
  ]);
});

test("cancelling a local upload waiting behind another command is not reported as a failure", async () => {
  let finish!: (stdout: string) => void;
  const execute = vi.fn<(command: string, path: string) => Promise<string>>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const source = { path: "assets/a.png", name: "a.png" };
  const view = { file: { path: "note.md" }, editor: fakeEditor("![](assets/a.png)") };
  const app = {
    vault: {
      getFiles: () => [source],
      adapter: { getBasePath: () => "/vault" },
      getAbstractFileByPath: () => null,
    },
    metadataCache: { getFirstLinkpathDest: () => source },
    workspace: { activeEditor: view, getLeavesOfType: () => [] },
  };
  const workflow = new UploadWorkflow(app as never, fullSettings(), new Uploader(execute));
  const blocker = workflow.uploadFile("/busy.png");
  let controller: AbortController | undefined;
  const progress = vi
    .spyOn(
      workflow as unknown as {
        createUploadProgress(controller: AbortController): { update(): void; close(): void };
      },
      "createUploadProgress",
    )
    .mockImplementation((value) => {
      controller = value;
      return { update: () => {}, close: () => {} };
    });
  const before = noticeMessages().length;
  try {
    const pending = workflow.uploadCurrentNote();
    controller!.abort();
    await pending;
    expect(noticeMessages().slice(before)).toEqual([
      "Uploaded: 0 · Failed: 0 · Skipped: 0 · Upload cancelled.",
    ]);
    expect(execute.mock.calls.map((call) => call[1])).toEqual(["/busy.png"]);
  } finally {
    finish("https://cdn.example/busy.png");
    await blocker;
    progress.mockRestore();
  }
});
