import type { App, Editor } from "obsidian";
import { expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => ({ Plugin: class {}, Notice: class {}, TFile: class {} }));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));
vi.mock("../src/settingsTab", () => ({ SettingTab: class {} }));

import AttachmentUploader from "../src/main";

test("does not handle an event already claimed by another plugin", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
  const event = new Event("paste", { cancelable: true });
  event.preventDefault();
  const replaceSelection = vi.fn<Editor["replaceSelection"]>();
  await (
    plugin as unknown as {
      handleFileInsertion: (
        event: Event,
        files: File[],
        editor: Editor,
        sourcePath: string,
      ) => Promise<void>;
    }
  ).handleFileInsertion(
    event,
    [new File([], "one.png")],
    { replaceSelection } as unknown as Editor,
    "note.md",
  );
  expect(replaceSelection).not.toHaveBeenCalled();
});

test("updates the source file atomically after its editor has closed", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
  const marker = "<!-- attachment-uploader:test -->";
  let saved = `before ${marker} after`;
  const source = { path: "source.md" };
  plugin.app = {
    workspace: { getLeavesOfType: () => [] },
    vault: {
      getFileByPath: (path: string) => (path === "source.md" ? source : null),
      process: vi.fn<(_file: unknown, transform: (content: string) => string) => Promise<string>>(
        async (_file, transform) => {
          saved = transform(saved);
          return saved;
        },
      ),
    },
  } as unknown as App;
  const editor = { getValue: () => "another note" } as unknown as Editor;
  const replaced = await (
    plugin as unknown as {
      replaceSourceMarker: (
        editor: Editor,
        marker: string,
        replacement: string,
        path: string,
      ) => Promise<boolean>;
    }
  ).replaceSourceMarker(editor, marker, "![image](https://cdn.example/a.png)", "source.md");
  expect(replaced).toBe(true);
  expect(saved).toBe("before ![image](https://cdn.example/a.png) after");
});

test("reserves all batch positions before uploading any file", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
  plugin.settings = {
    uploadCommand: "",
    isDeleteSourceFile: false,
    uploadFileFormat: new Set([".png"]),
  } as never;
  const replaceSelection = vi.fn<Editor["replaceSelection"]>();
  const editor = { replaceSelection } as unknown as Editor;
  const internals = plugin as unknown as {
    handleFileInsertion: (
      event: Event,
      files: File[],
      editor: Editor,
      sourcePath: string,
    ) => Promise<void>;
    uploadAndInsert: (...args: unknown[]) => Promise<void>;
  };
  let release!: () => void;
  const upload = vi
    .spyOn(internals, "uploadAndInsert")
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(undefined);
  const event = new Event("drop", { cancelable: true });
  const operation = internals.handleFileInsertion(
    event,
    [new File([], "one.png"), new File([], "two.png")],
    editor,
    "note.md",
  );
  expect(event.defaultPrevented).toBe(true);
  expect(replaceSelection).toHaveBeenCalledOnce();
  const markers = String(replaceSelection.mock.calls[0]![0]).split("\n");
  expect(markers).toHaveLength(2);
  expect(upload).toHaveBeenCalledTimes(1);
  release();
  await operation;
  expect(upload.mock.calls.map((call) => call[3])).toEqual(markers);
});

test("leaves mixed-format batches to Obsidian without intercepting the event", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
  plugin.settings = {
    uploadCommand: "",
    isDeleteSourceFile: false,
    uploadFileFormat: new Set([".png"]),
  } as never;
  const replaceSelection = vi.fn<Editor["replaceSelection"]>();
  const event = new Event("drop", { cancelable: true });
  await (
    plugin as unknown as {
      handleFileInsertion: (
        event: Event,
        files: File[],
        editor: Editor,
        sourcePath: string,
      ) => Promise<void>;
    }
  ).handleFileInsertion(
    event,
    [new File([], "one.png"), new File([], "notes.txt")],
    { replaceSelection } as unknown as Editor,
    "note.md",
  );
  expect(event.defaultPrevented).toBe(false);
  expect(replaceSelection).not.toHaveBeenCalled();
});

test("failed paste uses its source note after the active note changes", async () => {
  const plugin = new AttachmentUploader({} as never, {} as never);
  let activePath = "A/note.md";
  let content = "";
  const editor = {
    replaceSelection: (text: string) => {
      content = text;
    },
    getValue: () => content,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    replaceRange: (text: string, from: { ch: number }, to: { ch: number }) => {
      content = content.slice(0, from.ch) + text + content.slice(to.ch);
    },
  } as unknown as Editor;
  const availablePath = vi.fn<App["fileManager"]["getAvailablePathForAttachment"]>(
    async () => "A/image.png",
  );
  const generateLink = vi.fn<App["fileManager"]["generateMarkdownLink"]>(
    () => "[image](image.png)",
  );
  plugin.app = {
    workspace: { getActiveFile: () => ({ path: activePath }) },
    fileManager: {
      getAvailablePathForAttachment: availablePath,
      generateMarkdownLink: generateLink,
    },
    vault: {
      createBinary: vi.fn<() => Promise<{ path: string; extension: string }>>(async () => ({
        path: "A/image.png",
        extension: "png",
      })),
    },
  } as unknown as App;
  let finishUpload!: (value: { success: boolean; errorMessage: string }) => void;
  const uploadServe = vi.fn<() => Promise<{ success: boolean; errorMessage: string }>>(
    () =>
      new Promise<{ success: boolean; errorMessage: string }>((resolve) => {
        finishUpload = resolve;
      }),
  );
  vi.spyOn(plugin, "uploadService", "get").mockReturnValue({ uploadServe } as never);
  const file = new File(["image bytes"], "image.png");
  // Exercise the complete async operation, including temp-file creation and cleanup.
  const operation = (
    plugin as unknown as {
      uploadAndInsert: (file: File, editor: Editor, sourcePath: string) => Promise<void>;
    }
  ).uploadAndInsert(file, editor, "A/note.md");
  await vi.waitFor(() => expect(uploadServe).toHaveBeenCalledOnce());
  activePath = "B/note.md";
  finishUpload({ success: false, errorMessage: "offline" });
  await operation;
  expect(availablePath).toHaveBeenCalledWith("image.png", "A/note.md");
  expect(generateLink).toHaveBeenCalledWith(
    expect.objectContaining({ path: "A/image.png" }),
    "A/note.md",
  );
  expect(content).toBe("![image](image.png)");
});
