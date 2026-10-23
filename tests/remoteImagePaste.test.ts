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
    noticeEl = element();
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
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));
vi.mock("../src/settingsTab", () => ({ SettingTab: class {} }));

import { EditorState } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { editorInfoField, Notice } from "obsidian";
import type { Editor } from "obsidian";

import AttachmentUploader from "../src/main";
import type { RemoteImageScope } from "../src/services/imageTransferService";
import { RemoteImageDownloader } from "../src/services/remoteImageDownloader";
import { UploadService } from "../src/services/uploadService";
import {
  REMOTE_IMAGE_LIMIT_DEFAULTS,
  remoteImageRuleScopeKey,
  type RemoteImagePastePolicy,
} from "../src/settings";

function fullSettings() {
  return {
    ...REMOTE_IMAGE_LIMIT_DEFAULTS,
    uploadService: "uPic" as const,
    uploadCommand: "/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s",
    testFilePath: "",
    uploadFileFormat: new Set([".png"]),
    isDeleteSourceFile: false,
    autoUploadOnSave: false,
    remoteImagePastePolicy: "ask" as RemoteImagePastePolicy,
    remoteImageAutoDetectHost: false,
    remoteImageHostRules: {} as Record<string, string[]>,
    remoteImageAutoHostRules: {},
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
  const plugin = new AttachmentUploader({} as never, {} as never);
  plugin.settings = { ...fullSettings(), ...overrides };
  const start = vi.fn<(...args: unknown[]) => Promise<null>>(async () => null);
  (plugin as unknown as { startRemoteTransfer: typeof start }).startRemoteTransfer = start;
  return { plugin, start };
}

function notices() {
  return (Notice as unknown as { instances: Array<{ message: string | DocumentFragment }> })
    .instances;
}

async function paste(
  plugin: AttachmentUploader,
  text: string,
  options: { html?: string; editor?: ReturnType<typeof fakeEditor> } = {},
) {
  const editor = options.editor ?? fakeEditor();
  const event = eventData(text, options.html);
  await (
    plugin as unknown as {
      handlePasteUpload: (
        event: ClipboardEvent,
        editor: Editor,
        info: { file: { path: string } },
      ) => Promise<void>;
    }
  ).handlePasteUpload(event as unknown as ClipboardEvent, editor, {
    file: { path: "note.md" },
  });
  return { editor, event };
}

test("leaves plain Markdown alone when the paste policy is off", async () => {
  const { plugin, start } = createPlugin({ remoteImagePastePolicy: "off" });
  const { event, editor } = await paste(plugin, "![](https://cdn.example/a.png)");
  expect(event.defaultPrevented).toBe(false);
  expect(editor.getValue()).toBe("");
  expect(start).not.toHaveBeenCalled();
});

test("asks before transferring pasted remote images and inserts text immediately", async () => {
  const { plugin, start } = createPlugin({ remoteImagePastePolicy: "ask" });
  const text = "before ![](https://cdn.example/a.png) after";
  const { event, editor } = await paste(plugin, text);
  expect(event.defaultPrevented).toBe(true);
  expect(editor.getValue()).toBe(text);
  expect(start).not.toHaveBeenCalled();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const message = notices().at(-1)?.message;
  expect(String(message)).toContain("1");
});

test("starts the transfer automatically while keeping the pasted range", async () => {
  const { plugin, start } = createPlugin({ remoteImagePastePolicy: "auto" });
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
  const { plugin, start } = createPlugin({ remoteImagePastePolicy: "auto" });
  const { event } = await paste(plugin, "![](https://cdn.example/a.png)", {
    html: "<p>rich</p>",
  });
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

test("does not intercept text without supported remote images", async () => {
  const { plugin, start } = createPlugin({ remoteImagePastePolicy: "auto" });
  const { event } = await paste(plugin, "plain text and [a link](https://cdn.example/a.png)");
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

test("does not intercept when every image is already covered by a configured prefix", async () => {
  const settings = fullSettings();
  const scopeKey = remoteImageRuleScopeKey(settings.uploadService, settings.uploadCommand);
  const { plugin, start } = createPlugin({
    remoteImagePastePolicy: "auto",
    remoteImageHostRules: { [scopeKey]: ["https://cdn.example/"] },
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

test("shares an in-flight transfer for the same scope and mode", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
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
        mode: "normal",
        view: never,
      ) => Promise<ReturnType<typeof summary> | null>;
    }
  ).startRemoteTransfer.bind(plugin);

  const first = start("note.md", { kind: "note" }, "normal", view);
  const second = start("note.md", { kind: "note" }, "normal", view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(execute).toHaveBeenCalledOnce();
  pending[0]!(summary());
  await expect(first).resolves.toMatchObject({ succeeded: 1 });
  await expect(second).resolves.toMatchObject({ succeeded: 1 });
});

test("serializes different transfers on the same note", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
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
        scope: { kind: "note" } | { kind: "selection"; start: number; end: number },
        mode: "normal",
        view: never,
      ) => Promise<unknown>;
    }
  ).startRemoteTransfer.bind(plugin);

  const first = start("note.md", { kind: "note" }, "normal", view);
  const second = start("note.md", { kind: "selection", start: 0, end: 1 }, "normal", view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toHaveLength(1);
  release();
  await Promise.all([first, second]);
  expect(started).toHaveLength(2);
});

test("does not trust a stored automatic rule when deciding whether to intercept", async () => {
  const settings = fullSettings();
  const scopeKey = remoteImageRuleScopeKey(settings.uploadService, settings.uploadCommand);
  const { plugin, start } = createPlugin({
    remoteImagePastePolicy: "auto",
    remoteImageAutoDetectHost: false,
    remoteImageAutoHostRules: {
      [scopeKey]: {
        prefixes: ["https://cdn.example/"],
        source: "uPic",
        detectedAt: "2026-10-20T00:00:00.000Z",
        fingerprint: "stale",
      },
    },
  });
  const { event } = await paste(plugin, "![](https://cdn.example/a.png)");
  expect(event.defaultPrevented).toBe(true);
  expect(start).toHaveBeenCalledOnce();
});

test("never writes into a view that switched notes and falls back to the source file", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
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
  const plugin = new AttachmentUploader({} as never, {} as never);
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
  const { plugin, start } = createPlugin({ remoteImagePastePolicy: "auto" });
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

test.each(["auto", "ask"] as const)(
  "handles mixed local and externally defined remote images in %s mode",
  async (policy) => {
    const { plugin, start } = createPlugin({ remoteImagePastePolicy: policy });
    const definition = "[remote]: https://cdn.example/a.png\n\n";
    const editor = fakeEditor(definition);
    const text = "![local](assets/local.png)\n![remote][remote]";
    const noticeCount = notices().length;
    const { event } = await paste(plugin, text, { editor });
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getValue()).toBe(definition + text);
    if (policy === "auto") {
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0]![1]).toMatchObject({
        kind: "paste",
        start: definition.length,
        end: definition.length + text.length,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(start).not.toHaveBeenCalled();
      expect(notices()).toHaveLength(noticeCount + 1);
      expect(String(notices().at(-1)?.message)).toBe("1 pasted remote images can be transferred");
    }
  },
);

test("leaves mixed local images and an undefined reference to Obsidian", async () => {
  const { plugin, start } = createPlugin({ remoteImagePastePolicy: "auto" });
  const { event } = await paste(plugin, "![local](assets/local.png)\n![remote][missing]");
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

test("leaves a pasted fragment with only local reference images to Obsidian", async () => {
  const { plugin, start } = createPlugin({ remoteImagePastePolicy: "auto" });
  const text = "![a][local]\n\n[local]: assets/a.png";
  const { event } = await paste(plugin, text);
  expect(event.defaultPrevented).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

interface TargetSnapshot {
  generation: number;
  key: string;
  command: string;
  outputs: Set<string>;
  uploader: { uploadServe(path: string): Promise<{ success: boolean; url?: string }> };
}

function targetAccess(plugin: AttachmentUploader) {
  return plugin as unknown as {
    captureRemoteTarget(): TargetSnapshot;
    acceptRemoteFingerprint(fingerprint: string | null): void;
    remoteOutputUrls: Set<string>;
    lastSuccessfulUploadUrl: string | null;
    lastSuccessfulUploadScope: string | null;
  };
}

test("switching target replaces session records, rejects late writes and preserves manual rules", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
  plugin.settings = fullSettings() as never;
  const access = targetAccess(plugin);
  const key = remoteImageRuleScopeKey(plugin.settings.uploadService, plugin.settings.uploadCommand);
  plugin.settings.remoteImageHostRules[key] = ["https://manual.example/"];
  const old = access.captureRemoteTarget();
  old.outputs.add("https://old.example/one.png");
  plugin.settings.uploadCommand = "new-uploader %s";
  const current = access.captureRemoteTarget();
  old.outputs.add("https://old.example/late.png");
  expect(current.outputs.size).toBe(0);
  expect(current.outputs).not.toBe(old.outputs);
  expect(current.generation).toBeGreaterThan(old.generation);
  expect(plugin.settings.remoteImageHostRules[key]).toEqual(["https://manual.example/"]);
  // Switching back also starts a fresh generation; an older A job isn't current.
  plugin.settings.uploadCommand = fullSettings().uploadCommand;
  expect(access.captureRemoteTarget().outputs.size).toBe(0);
  expect(access.captureRemoteTarget().generation).toBeGreaterThan(current.generation);
});

test("uPic fingerprint changes and explicit clearing invalidate only session detection", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
  plugin.settings = fullSettings() as never;
  plugin.saveData = async () => {};
  const access = targetAccess(plugin);
  access.captureRemoteTarget();
  access.acceptRemoteFingerprint("host-A");
  const old = access.captureRemoteTarget();
  old.outputs.add("https://old.example/a.png");
  access.acceptRemoteFingerprint("host-B");
  const next = access.captureRemoteTarget();
  expect(next.outputs.size).toBe(0);
  expect(next.generation).toBeGreaterThan(old.generation);
  access.acceptRemoteFingerprint("host-B");
  expect(access.captureRemoteTarget().generation).toBe(next.generation);
  next.outputs.add("https://new.example/a.png");
  await plugin.clearRemoteImageDetection();
  expect(access.captureRemoteTarget().outputs.size).toBe(0);
  old.outputs.add("https://old.example/late.png");
  expect(access.captureRemoteTarget().outputs.size).toBe(0);
});

test("fresh uPic detection is not bypassed by an old session output during paste", async () => {
  const { plugin, start } = createPlugin({
    remoteImagePastePolicy: "auto",
    remoteImageAutoDetectHost: true,
  });
  const access = targetAccess(plugin);
  access.captureRemoteTarget().outputs.add("https://old.example/a.png");
  const { event } = await paste(plugin, "![](https://old.example/a.png)");
  expect(event.defaultPrevented).toBe(true);
  expect(start).toHaveBeenCalledOnce();
});

test("queued operations freeze their upload command before settings change", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
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
    _mode: string,
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
      mode: string,
      view: unknown,
    ): Promise<unknown>;
  };
  access.executeRemoteImageTransfer = execute;
  const view = { file: { path: "note.md" } };
  const first = access.startRemoteTransfer("note.md", { kind: "note" }, "normal", view);
  const queued = access.startRemoteTransfer(
    "note.md",
    { kind: "selection", start: 0, end: 2 },
    "normal",
    view,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  plugin.settings.uploadCommand = "new-uploader %s";
  const next = access.startRemoteTransfer("note.md", { kind: "note" }, "normal", view);
  finish();
  await Promise.all([first, queued, next]);
  expect(targets.map((target) => target.command)).toEqual([original, original, "new-uploader %s"]);
});

test("the editor hook maps captured references and rejects a file switch even without text changes", () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
  const anchor = "![](https://cdn.example/a.png)";
  const editor = fakeEditor(anchor);
  const view = { file: { path: "note.md" }, editor };
  const scope: RemoteImageScope = { kind: "note" };
  const access = plugin as unknown as {
    captureReferenceScope(scope: RemoteImageScope, view: unknown): void;
    updateReferenceTrackers(update: ViewUpdate): void;
  };
  access.captureReferenceScope(scope, view);
  const state = EditorState.create({
    doc: anchor,
    extensions: [editorInfoField.init(() => view as never)],
  });
  const transaction = state.update({ changes: { from: 0, insert: "prefix\n" } });
  access.updateReferenceTrackers({
    startState: state,
    state: transaction.state,
    docChanged: true,
    transactions: [transaction],
  } as unknown as ViewUpdate);
  expect(scope.tracker!.references(transaction.newDoc.toString())[0]?.start).toBe(7);
  view.file = { path: "other.md" };
  access.updateReferenceTrackers({
    startState: transaction.state,
    state: transaction.state,
    docChanged: false,
    transactions: [],
  } as unknown as ViewUpdate);
  view.file = { path: "note.md" };
  expect(scope.tracker!.references(transaction.newDoc.toString())).toEqual([]);
});

test("different notes upload separately through one command queue", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
  plugin.settings = fullSettings() as never;
  plugin.app = { workspace: { getLeavesOfType: () => [] } } as never;
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
  const upload = vi.spyOn(UploadService.prototype, "uploadServe").mockImplementation(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running--;
    return { success: true, url: "https://new.example/a.png" };
  });
  const access = plugin as unknown as {
    startRemoteTransfer(
      path: string,
      scope: RemoteImageScope,
      mode: string,
      view: unknown,
    ): Promise<unknown>;
  };
  try {
    await Promise.all(
      ["A.md", "B.md"].map((path) =>
        access.startRemoteTransfer(path, { kind: "note" }, "normal", {
          file: { path },
          editor: fakeEditor("![](https://source.example/a.png)"),
        }),
      ),
    );
    expect(downloads).toBe(2);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  } finally {
    download.mockRestore();
    upload.mockRestore();
  }
});

test("an old running transfer cannot restore session URLs or prefix suggestions after target switch", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
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
  const upload = vi.spyOn(UploadService.prototype, "uploadServe").mockImplementation(async () => {
    started();
    return await new Promise((resolve) => {
      finish = resolve;
    });
  });
  const access = plugin as unknown as {
    startRemoteTransfer(
      path: string,
      scope: RemoteImageScope,
      mode: string,
      view: unknown,
    ): Promise<unknown>;
  };
  try {
    const operation = access.startRemoteTransfer("A.md", { kind: "note" }, "normal", {
      file: { path: "A.md" },
      editor: fakeEditor("![](https://source.example/a.png)"),
    });
    await gate;
    plugin.settings.uploadCommand = "new-target %s";
    const next = targetAccess(plugin).captureRemoteTarget();
    finish({ success: true, url: "https://old.example/late.png" });
    await operation;
    expect(next.outputs.size).toBe(0);
    expect(plugin.suggestRemoteImagePrefix()).toBeNull();
  } finally {
    download.mockRestore();
    upload.mockRestore();
  }
});
