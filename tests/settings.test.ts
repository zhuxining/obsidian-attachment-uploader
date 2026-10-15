import { expect, test } from "vite-plus/test";

import { parseSettings, serializeSettings } from "../src/settings";

test("default settings never share mutable format sets", () => {
  const first = parseSettings(null);
  first.uploadFileFormat.clear();
  expect(parseSettings(undefined).uploadFileFormat.has(".png")).toBe(true);
});

test("rejects malformed persisted settings and unknown service names", () => {
  const settings = parseSettings({
    uploadService: "toString",
    uploadCommand: 42,
    autoUploadOnSave: "false",
    testFilePath: null,
  });
  expect(settings.uploadService).toBe("uPic");
  expect(typeof settings.uploadCommand).toBe("string");
  expect(settings.autoUploadOnSave).toBe(false);
  expect(settings.testFilePath).toBe("");
});

test("normalizes persisted formats and preserves custom commands across serialization", () => {
  const settings = parseSettings({
    uploadService: "custom",
    uploadCommand: "wrapper %s",
    uploadFileFormat: "PNG, .JPG png",
  });
  expect([...settings.uploadFileFormat]).toEqual([".png", ".jpg"]);
  expect(parseSettings(serializeSettings(settings))).toEqual(settings);
});
