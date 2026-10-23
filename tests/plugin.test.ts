import { expect, test, vi } from "vite-plus/test";

const workflow = vi.hoisted(() => ({
  uploadCurrentNote: vi.fn<() => Promise<void>>(async () => {}),
  handlePaste: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  handleDrop: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  uploadFile: vi.fn<(path: string) => Promise<{ success: boolean; url: string }>>(async () => ({
    success: true,
    url: "https://cdn.example/test.png",
  })),
  updateEditor: vi.fn<() => void>(),
  detachEditor: vi.fn<() => void>(),
  dispose: vi.fn<() => void>(),
}));
vi.mock("../src/uploadWorkflow", () => ({
  UploadWorkflow: class {
    constructor() {
      return workflow;
    }
  },
}));
vi.mock("../src/settingsTab", () => ({ SettingTab: class {} }));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));
vi.mock("obsidian", () => ({
  editorInfoField: {},
  Plugin: class {
    app: unknown;
    commands: Array<{ id: string; editorCallback: () => Promise<void> }> = [];
    ribbon?: () => void;
    cleanups: Array<() => void> = [];
    saved?: unknown;
    constructor(app: unknown) {
      this.app = app;
    }
    async loadData() {
      return { autoUpload: false };
    }
    async saveData(data: unknown) {
      this.saved = data;
    }
    registerEditorExtension(_extension: unknown) {}
    register(cleanup: () => void) {
      this.cleanups.push(cleanup);
    }
    registerEvent(_event: unknown) {}
    addRibbonIcon(_icon: string, _label: string, callback: () => void) {
      this.ribbon = callback;
    }
    addCommand(command: { id: string; editorCallback: () => Promise<void> }) {
      this.commands.push(command);
    }
    addSettingTab(_tab: unknown) {}
  },
}));

import AttachmentUploader from "../src/main";

test("the plugin wires one command, ribbon, paste/drop and cleanup to the workflow", async () => {
  const events = new Map<string, (...args: unknown[]) => Promise<void>>();
  const app = {
    workspace: {
      on: (name: string, handler: (...args: unknown[]) => Promise<void>) => {
        events.set(name, handler);
        return {};
      },
    },
  };
  const plugin = new AttachmentUploader(app as never, {} as never);
  await plugin.onload();
  const harness = plugin as unknown as {
    commands: Array<{ id: string; editorCallback(): Promise<void> }>;
    ribbon(): void;
    cleanups: Array<() => void>;
  };
  expect(harness.commands.map((command) => command.id)).toEqual(["upload-editor-attachments"]);
  await harness.commands[0]!.editorCallback();
  harness.ribbon();
  expect(workflow.uploadCurrentNote).toHaveBeenCalledTimes(2);
  expect([...events.keys()]).toEqual(["editor-paste", "editor-drop"]);
  await events.get("editor-paste")!("paste", "editor", "note");
  await events.get("editor-drop")!("drop", "editor", "note");
  expect(workflow.handlePaste).toHaveBeenCalledExactlyOnceWith("paste", "editor", "note");
  expect(workflow.handleDrop).toHaveBeenCalledExactlyOnceWith("drop", "editor", "note");
  await expect(plugin.uploadServe("/test.png")).resolves.toMatchObject({ success: true });
  expect(workflow.uploadFile).toHaveBeenCalledExactlyOnceWith("/test.png");
  expect(plugin.settings.autoUpload).toBe(false);
  for (const cleanup of harness.cleanups) cleanup();
  expect(workflow.dispose).toHaveBeenCalledOnce();
});
