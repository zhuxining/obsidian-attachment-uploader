import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Notice, TFile } from "obsidian";
import type { App, Editor } from "obsidian";
import { expect, test, vi } from "vite-plus/test";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn<typeof actual.homedir>(actual.homedir) };
});
vi.mock("obsidian", () => ({
  Plugin: class {},
  Notice: vi.fn<(message: string, timeout?: number) => void>(),
  TFile: class {},
}));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));
vi.mock("../src/settingsTab", () => ({ SettingTab: class {} }));

import AttachmentUploader from "../src/main";
import * as uploadReceipts from "../src/services/uploadReceipts";

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

async function withRecoveryFixture(
  run: (fixture: {
    home: string;
    bytes: Buffer;
    plugin: AttachmentUploader;
    uploadServe: ReturnType<
      typeof vi.fn<(path: string) => Promise<{ success: boolean; url?: string }>>
    >;
    insert: () => Promise<void>;
  }) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "attachment-recovery-test-"));
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  const plugin = new AttachmentUploader({} as never, {} as never);
  const uploadServe = vi.fn<(path: string) => Promise<{ success: boolean; url?: string }>>();
  uploadServe.mockResolvedValue({ success: false });
  const uploadService = vi.spyOn(plugin, "uploadService", "get").mockReturnValue({
    uploadServe,
    formatUploadedFile: () => "![image](https://cdn.example/a.png)",
  } as never);
  const internals = plugin as unknown as {
    uploadAndInsert: (file: File, editor: Editor, sourcePath: string) => Promise<void>;
  };
  vi.mocked(homedir).mockReturnValue(home);
  vi.mocked(Notice).mockClear();
  try {
    await run({
      home,
      bytes,
      plugin,
      uploadServe,
      insert: () =>
        internals.uploadAndInsert(
          new File([bytes], "image.png"),
          {
            replaceSelection: vi.fn<Editor["replaceSelection"]>(),
            getValue: () => "another note",
          } as unknown as Editor,
          "note.md",
        ),
    });
  } finally {
    vi.mocked(homedir).mockReset();
    vi.mocked(Notice).mockClear();
    uploadService.mockRestore();
    try {
      for (const [path] of uploadServe.mock.calls) {
        await rm(dirname(path), { recursive: true, force: true });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

test("preserves recovery bytes and removes the temporary copy when cloud and vault fail", async () => {
  await withRecoveryFixture(async ({ home, bytes, plugin, uploadServe, insert }) => {
    const createBinary = vi
      .fn<App["vault"]["createBinary"]>()
      .mockRejectedValue(new Error("vault unavailable"));
    plugin.app = {
      fileManager: {
        getAvailablePathForAttachment: vi
          .fn<App["fileManager"]["getAvailablePathForAttachment"]>()
          .mockResolvedValue("image.png"),
      },
      vault: { createBinary },
    } as unknown as App;

    await insert();

    expect(createBinary).toHaveBeenCalledOnce();
    expect(uploadServe).toHaveBeenCalledOnce();
    const root = join(home, ".obsidian-attachment-uploader-recovery");
    const directories = await readdir(root);
    expect(directories).toHaveLength(1);
    expect(directories[0]).toMatch(/^attachment-/);
    const directory = join(root, directories[0]!);
    expect(await readdir(directory)).toEqual(["image.png"]);
    const recoveryPath = join(directory, "image.png");
    expect(await readFile(recoveryPath)).toEqual(bytes);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(recoveryPath)).mode & 0o777).toBe(0o600);
    await expect(stat(dirname(uploadServe.mock.calls[0]![0]))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(Notice).toHaveBeenCalledWith(`Attachment recovery copy saved: ${recoveryPath}`, 0);
  });
});

test.each(["removed", "exception", "switched"])(
  "persists the cloud result when paste insertion is %s",
  async (failure) => {
    await withRecoveryFixture(async ({ home, plugin, uploadServe, insert }) => {
      const createBinary = vi.fn<App["vault"]["createBinary"]>();
      plugin.app = {
        vault: { createBinary, getFileByPath: () => null },
        workspace: { getLeavesOfType: () => [{ view: { file: { path: "another.md" } } }] },
      } as unknown as App;
      const internals = plugin as unknown as {
        replaceSourceMarker: (...args: unknown[]) => Promise<boolean>;
      };
      const replacement =
        failure === "switched" ? undefined : vi.spyOn(internals, "replaceSourceMarker");
      if (failure === "exception") replacement?.mockRejectedValue(new Error("insertion failed"));
      else replacement?.mockResolvedValue(false);
      uploadServe.mockResolvedValue({ success: true, url: "https://cdn.example/a.png" });
      try {
        await insert();
        const root = join(home, ".obsidian-attachment-uploader-recovery");
        const directories = await readdir(root);
        expect(directories).toHaveLength(1);
        const path = join(root, directories[0]!, "receipt.json");
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
          URL: "https://cdn.example/a.png",
          sourcePath: "note.md",
          filename: "image.png",
          timestamp: expect.any(String),
        });
        expect(Notice).toHaveBeenCalledWith(
          `${uploadReceipts.UPLOAD_RECEIPT_KEYS.saved} ${path}\nhttps://cdn.example/a.png`,
          0,
        );
        expect(createBinary).not.toHaveBeenCalled();
        await expect(stat(dirname(uploadServe.mock.calls[0]![0]))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        replacement?.mockRestore();
      }
    });
  },
);

test.each(["zero", "exception"])(
  "preserves automatic upload results after %s replacements",
  async (failure) => {
    const plugin = new AttachmentUploader({} as never, {} as never);
    plugin.settings = { autoUploadOnSave: true } as never;
    const file = Object.assign(new TFile(), { path: "assets/a.png", name: "a.png" });
    const replaceLocalLinksInAllEditors = vi.fn<() => Promise<number>>();
    if (failure === "exception")
      replaceLocalLinksInAllEditors.mockRejectedValue(new Error("editor failed"));
    else replaceLocalLinksInAllEditors.mockResolvedValue(0);
    const service = vi.spyOn(plugin, "uploadService", "get").mockReturnValue({
      isUploadableFile: () => true,
      uploadServe: async () => ({ success: true, url: "https://cdn.example/a.png" }),
      replaceLocalLinksInAllEditors,
    } as never);
    const receipt = vi.spyOn(uploadReceipts, "preserveUploadReceipt").mockResolvedValue(undefined);
    plugin.app = {
      vault: { adapter: { getBasePath: () => "/vault" } },
      workspace: { getLeavesOfType: () => [{ view: { file: { path: "note.md" } } }] },
      metadataCache: {
        getFileCache: () => ({ embeds: [{ link: "assets/a.png" }] }),
        getFirstLinkpathDest: () => file,
      },
    } as unknown as App;
    try {
      await (
        plugin as unknown as { handleAutoUploadOnSave: (file: TFile) => Promise<void> }
      ).handleAutoUploadOnSave(file);
      expect(receipt).toHaveBeenCalledExactlyOnceWith(
        "https://cdn.example/a.png",
        "/vault/assets/a.png",
        "a.png",
      );
    } finally {
      receipt.mockRestore();
      service.mockRestore();
    }
  },
);

test("retains the temporary bytes when the recovery root cannot be created", async () => {
  await withRecoveryFixture(async ({ home, bytes, plugin, uploadServe, insert }) => {
    const blockedHome = join(home, "not-a-directory");
    await writeFile(blockedHome, "blocked");
    vi.mocked(homedir).mockReturnValue(blockedHome);
    plugin.app = {
      fileManager: {
        getAvailablePathForAttachment: vi
          .fn<App["fileManager"]["getAvailablePathForAttachment"]>()
          .mockResolvedValue("image.png"),
      },
      vault: {
        createBinary: vi
          .fn<App["vault"]["createBinary"]>()
          .mockRejectedValue(new Error("vault unavailable")),
      },
    } as unknown as App;

    await insert();

    expect(uploadServe).toHaveBeenCalledOnce();
    const temporaryPath = uploadServe.mock.calls[0]![0];
    expect(await readFile(temporaryPath)).toEqual(bytes);
    expect(Notice).toHaveBeenCalledWith(
      expect.stringContaining(
        `Attachment recovery failed; temporary copy retained: ${dirname(temporaryPath)}\n`,
      ),
      0,
    );
    expect(await readdir(home)).toEqual(["not-a-directory"]);
  });
});

test("does not create a recovery copy when vault save succeeds but link generation throws", async () => {
  await withRecoveryFixture(async ({ home, bytes, plugin, uploadServe, insert }) => {
    const createBinary = vi
      .fn<(path: string, data: ArrayBuffer) => Promise<{ path: string; extension: string }>>()
      .mockResolvedValue({ path: "attachments/image.png", extension: "png" });
    const generateMarkdownLink = vi.fn<App["fileManager"]["generateMarkdownLink"]>(() => {
      throw new Error("link generation failed");
    });
    plugin.app = {
      fileManager: {
        getAvailablePathForAttachment: vi
          .fn<App["fileManager"]["getAvailablePathForAttachment"]>()
          .mockResolvedValue("attachments/image.png"),
        generateMarkdownLink,
      },
      vault: { createBinary },
    } as unknown as App;

    await insert();

    expect(createBinary).toHaveBeenCalledOnce();
    expect(createBinary).toHaveBeenCalledWith("attachments/image.png", expect.any(ArrayBuffer));
    expect(Buffer.from(createBinary.mock.calls[0]![1])).toEqual(bytes);
    expect(generateMarkdownLink).toHaveBeenCalledOnce();
    expect(await readdir(home)).toEqual([]);
    expect(homedir).not.toHaveBeenCalled();
    expect(uploadServe).toHaveBeenCalledOnce();
    await expect(stat(dirname(uploadServe.mock.calls[0]![0]))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(Notice).toHaveBeenCalledWith(
      expect.stringContaining("Attachment recovery copy saved: attachments/image.png\n"),
      0,
    );
  });
});
