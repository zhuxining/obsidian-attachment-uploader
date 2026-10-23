import { beforeEach, expect, test, vi } from "vite-plus/test";

const notices: string[] = [];
vi.mock("obsidian", () => ({
  PluginSettingTab: class {
    app: unknown;
    plugin: unknown;
    containerEl = {};
    constructor(app: unknown, plugin: unknown) {
      this.app = app;
      this.plugin = plugin;
    }
    update = vi.fn<() => void>();
    refreshDomState = vi.fn<() => void>();
  },
  Notice: class {
    constructor(message: string) {
      notices.push(message);
    }
  },
}));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));

import { parseSettings } from "../src/settings";
import { SettingTab } from "../src/settingsTab";

beforeEach(() => {
  notices.length = 0;
});

function setup(data: unknown = null) {
  const plugin = {
    settings: parseSettings(data),
    saveSettings: vi.fn<() => Promise<void>>(async () => {}),
    uploadServe: vi.fn<
      (path: string) => Promise<{ success: boolean; url?: string; errorMessage?: string }>
    >(async () => ({ success: true, url: "https://cdn.example/test.png" })),
  };
  const tab = new SettingTab({} as never, plugin as never);
  const internals = tab as unknown as { update: () => void; refreshDomState: () => void };
  return { plugin, tab, internals };
}

function groups(tab: SettingTab) {
  const definitions = tab.getSettingDefinitions();
  return definitions.map((definition) => ({
    definition,
    items: "items" in definition ? (definition.items ?? []) : [],
  }));
}

test("settings are ordered into tool, behavior and remote groups", () => {
  const { tab } = setup();
  const layout = groups(tab);
  expect(layout).toHaveLength(3);
  expect(
    layout.map((group) => ("heading" in group.definition ? group.definition.heading : "")),
  ).toEqual(["Upload tool", "Upload options", "Skip rules"]);
  expect(layout[0]!.items.map((item) => ("name" in item ? item.name : ""))).toEqual([
    "Upload service",
    "Executed command",
    "Test upload",
  ]);
  expect(layout[1]!.items.map((item) => ("name" in item ? item.name : ""))).toEqual([
    "Auto upload",
    "Include remote images",
    "Attachment format to be uploaded",
    "Delete local files after successful upload",
  ]);
  expect(layout[2]!.items.map((item) => ("name" in item ? item.name : ""))).toEqual([
    "Remote image URL prefixes to skip",
  ]);
});

test("the custom command row appears only for a custom tool", () => {
  const { plugin, tab } = setup({ uploadService: "custom" });
  const command = groups(tab)[0]!.items[1]!;
  expect(command.visible).toBeTypeOf("function");
  expect((command.visible as () => boolean)()).toBe(true);
  plugin.settings.uploadService = "uPic";
  expect((command.visible as () => boolean)()).toBe(false);
});

test("remote image inclusion is disabled while auto upload is off", () => {
  const { plugin, tab } = setup({ autoUpload: false });
  const remote = groups(tab)[1]!.items[1]!;
  const disabled = "control" in remote ? remote.control?.disabled : undefined;
  expect(disabled).toBeTypeOf("function");
  expect((disabled as () => boolean)()).toBe(true);
  plugin.settings.autoUpload = true;
  expect((disabled as () => boolean)()).toBe(false);
});

test("stored sets and arrays are exposed as editable text", () => {
  const { tab } = setup({
    uploadFileFormat: "PNG, jpg",
    remoteImageSkipPrefixes: ["https://a.example/x/", "https://b.example/y/"],
  });
  expect(tab.getControlValue("uploadFileFormat")).toBe(".png, .jpg");
  expect(tab.getControlValue("remoteImageSkipPrefixes")).toBe(
    "https://a.example/x/\nhttps://b.example/y/",
  );
  expect(tab.getControlValue("autoUpload")).toBe(true);
});

test("control writes persist parsed values and refresh dependent rows", async () => {
  const { plugin, tab, internals } = setup();
  await tab.setControlValue("uploadFileFormat", ".png, .pdf");
  expect(plugin.settings.uploadFileFormat).toEqual(new Set([".png", ".pdf"]));
  await tab.setControlValue(
    "remoteImageSkipPrefixes",
    " https://a.example/x/ \n\n https://b.example/y/ ",
  );
  expect(plugin.settings.remoteImageSkipPrefixes).toEqual([
    "https://a.example/x/",
    "https://b.example/y/",
  ]);
  expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
  await tab.setControlValue("autoUpload", false);
  expect(plugin.settings.autoUpload).toBe(false);
  expect(internals.refreshDomState).toHaveBeenCalledOnce();
});

test("switching tools updates the command and re-renders structure", async () => {
  const { plugin, tab, internals } = setup({ uploadService: "uPic" });
  await tab.setControlValue("uploadService", "Picsee");
  expect(plugin.settings.uploadService).toBe("Picsee");
  expect(plugin.settings.uploadCommand).toContain("Picsee.app");
  expect(internals.update).toHaveBeenCalledOnce();
  await tab.setControlValue("uploadService", "custom");
  expect(plugin.settings.uploadService).toBe("custom");
  expect(plugin.settings.uploadCommand).toBe("");
});

test("unknown or mistyped values are ignored", async () => {
  const { plugin, tab } = setup();
  const before = structuredClone(plugin.settings);
  await tab.setControlValue("uploadService", "unknown");
  await tab.setControlValue("autoUpload", "yes");
  await tab.setControlValue("unknownKey", true);
  expect(plugin.settings.uploadService).toBe(before.uploadService);
  expect(plugin.settings.autoUpload).toBe(before.autoUpload);
  expect(plugin.saveSettings).not.toHaveBeenCalled();
});

function fakeSetting() {
  const state = {
    placeholder: "",
    buttonText: "",
    disabled: false,
    change: undefined as ((value: string) => void) | undefined,
    click: undefined as (() => Promise<void>) | undefined,
  };
  const text = {
    setPlaceholder(value: string) {
      state.placeholder = value;
      return text;
    },
    onChange(callback: (value: string) => void) {
      state.change = callback;
      return text;
    },
  };
  const button = {
    setButtonText(value: string) {
      state.buttonText = value;
      return button;
    },
    setDisabled(value: boolean) {
      state.disabled = value;
      return button;
    },
    onClick(callback: () => Promise<void>) {
      state.click = callback;
      return button;
    },
  };
  const setting = {
    addText(callback: (control: typeof text) => unknown) {
      callback(text);
      return setting;
    },
    addButton(callback: (control: typeof button) => unknown) {
      callback(button);
      return setting;
    },
  };
  return { setting, state };
}

async function renderTest(tab: SettingTab) {
  const { setting, state } = fakeSetting();
  const definition = groups(tab)[0]!.items[2]!;
  if (!("render" in definition) || !definition.render) throw new Error("missing render");
  definition.render(setting as never, {} as never);
  return state;
}

test("the test upload row needs a path before uploading", async () => {
  const { plugin, tab } = setup();
  const state = await renderTest(tab);
  expect(state.placeholder).toBe("Test file path");
  expect(state.buttonText).toBe("Upload test");
  await state.click!();
  expect(plugin.uploadServe).not.toHaveBeenCalled();
  expect(notices.at(-1)).toBe("Enter the test file path");
});

test("the test upload row reports success and restores its button", async () => {
  const { plugin, tab } = setup();
  const state = await renderTest(tab);
  state.change!(" /tmp/a.png ");
  await state.click!();
  expect(plugin.uploadServe).toHaveBeenCalledExactlyOnceWith("/tmp/a.png");
  expect(notices.at(-1)).toContain("https://cdn.example/test.png");
  expect(state.disabled).toBe(false);
});

test("the test upload row reports failures and restores its button", async () => {
  const { plugin, tab } = setup();
  plugin.uploadServe.mockResolvedValueOnce({ success: false, errorMessage: "tool offline" });
  const state = await renderTest(tab);
  state.change!("/tmp/a.png");
  await state.click!();
  expect(notices.at(-1)).toBe("Upload failed: tool offline");
  expect(state.disabled).toBe(false);
});
