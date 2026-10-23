import { beforeEach, expect, test, vi } from "vite-plus/test";

const ui = vi.hoisted(() => {
  class Element {
    tag: string;
    children: Element[] = [];
    constructor(tag = "div") {
      this.tag = tag;
    }
    empty() {
      this.children = [];
    }
    createEl(tag: string, _options?: unknown): Element {
      const child = new Element(tag);
      this.children.push(child);
      return child;
    }
  }
  class Control {
    value: string | boolean = "";
    disabled = false;
    change?: (value: never) => unknown;
    click?: () => Promise<void>;
    inputEl = { setAttribute: () => {} };
    setValue(value: string | boolean) {
      this.value = value;
      return this;
    }
    setDisabled(value: boolean) {
      this.disabled = value;
      return this;
    }
    addOptions(_options: unknown) {
      return this;
    }
    setButtonText(_text: string) {
      return this;
    }
    onChange(callback: (value: never) => unknown) {
      this.change = callback;
      return this;
    }
    onClick(callback: () => Promise<void>) {
      this.click = callback;
      return this;
    }
  }
  class Setting {
    static instances: Setting[] = [];
    name = "";
    controls: Control[] = [];
    constructor(_element: Element) {
      Setting.instances.push(this);
    }
    setName(name: string) {
      this.name = name;
      return this;
    }
    setDesc(_description: string) {
      return this;
    }
    setDisabled(disabled: boolean) {
      for (const control of this.controls) control.disabled = disabled;
      return this;
    }
    addControl(callback: (control: Control) => unknown) {
      const control = new Control();
      this.controls.push(control);
      callback(control);
      return this;
    }
    addToggle(callback: (control: Control) => unknown) {
      return this.addControl(callback);
    }
    addDropdown(callback: (control: Control) => unknown) {
      return this.addControl(callback);
    }
    addText(callback: (control: Control) => unknown) {
      return this.addControl(callback);
    }
    addTextArea(callback: (control: Control) => unknown) {
      return this.addControl(callback);
    }
    addButton(callback: (control: Control) => unknown) {
      return this.addControl(callback);
    }
  }
  return { Element, Setting };
});
vi.mock("obsidian", () => ({
  PluginSettingTab: class {
    containerEl = new ui.Element();
  },
  Setting: ui.Setting,
  Notice: class {},
}));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));

import { parseSettings } from "../src/settings";
import { SettingTab } from "../src/settingsTab";

beforeEach(() => {
  ui.Setting.instances = [];
});

function setup(data: unknown = null) {
  const plugin = {
    settings: parseSettings(data),
    saveSettings: vi.fn<() => Promise<void>>(async () => {}),
    uploadServe: vi.fn<(path: string) => Promise<{ success: boolean; url: string }>>(async () => ({
      success: true,
      url: "https://cdn.example/test.png",
    })),
  };
  const tab = new SettingTab({} as never, plugin as never);
  tab.display();
  return { plugin, tab };
}

function control(name: string, index = 0) {
  const setting = ui.Setting.instances.find((candidate) => candidate.name === name);
  if (!setting?.controls[index]) throw new Error(`Missing setting: ${name}`);
  return setting.controls[index];
}

test("the remote inclusion control disables with the main switch and retains its value", async () => {
  const { plugin } = setup({ autoUpload: false, autoTransferRemoteImages: true });
  const remote = control("Include remote images");
  expect(remote.disabled).toBe(true);
  expect(remote.value).toBe(true);
  await control("Auto upload").change?.(true as never);
  expect(remote.disabled).toBe(false);
  expect(plugin.settings.autoTransferRemoteImages).toBe(true);
  await control("Auto upload").change?.(false as never);
  expect(remote.disabled).toBe(true);
  expect(plugin.settings.autoTransferRemoteImages).toBe(true);
});

test.each(["uPic", "Picsee", "custom"])(
  "only custom tools show the command editor: %s",
  (service) => {
    setup({ uploadService: service });
    expect(ui.Setting.instances.some((setting) => setting.name === "Executed command")).toBe(
      service === "custom",
    );
  },
);

test("the collapsed upload test sends the file without saving its path", async () => {
  const { plugin, tab } = setup();
  const details = (tab.containerEl as unknown as InstanceType<typeof ui.Element>).children.find(
    (child) => child.tag === "details",
  );
  expect(details).toBeDefined();
  await control("Test file path").change?.(" /private/test.png " as never);
  expect(plugin.saveSettings).not.toHaveBeenCalled();
  await control("Test file path", 1).click?.();
  expect(plugin.uploadServe).toHaveBeenCalledExactlyOnceWith("/private/test.png");
  expect(plugin.settings).not.toHaveProperty("testFilePath");
});
