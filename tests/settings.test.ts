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
  expect(settings.autoUpload).toBe(true);
  expect(settings).not.toHaveProperty("testFilePath");
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

test("auto-upload defaults on, remote inclusion and source deletion default off", () => {
  expect(parseSettings(null)).toMatchObject({
    autoUpload: true,
    autoTransferRemoteImages: false,
    isDeleteSourceFile: false,
  });
});

test("retains the remote inclusion preference when automatic uploading is off", () => {
  const settings = parseSettings({ autoUpload: false, autoTransferRemoteImages: true });
  expect(parseSettings(serializeSettings(settings))).toMatchObject({
    autoUpload: false,
    autoTransferRemoteImages: true,
  });
});

test("removed file-change automation and test paths are not persisted", () => {
  const settings = serializeSettings(
    parseSettings({ autoUploadOnSave: true, testFilePath: "/private/test.png" }),
  );
  expect(settings).not.toHaveProperty("autoUploadOnSave");
  expect(settings).not.toHaveProperty("testFilePath");
});
