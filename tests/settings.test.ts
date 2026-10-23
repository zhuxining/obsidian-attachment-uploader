import { expect, test } from "vite-plus/test";

import { REMOTE_IMAGE_LIMIT_DEFAULTS, parseSettings, serializeSettings } from "../src/settings";

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

test("remote image limits retain existing defaults and round-trip user values", () => {
  const defaults = parseSettings(null);
  for (const [key, value] of Object.entries(REMOTE_IMAGE_LIMIT_DEFAULTS)) {
    expect(defaults).toHaveProperty(key, value);
  }
  const overrides = {
    remoteImageMaxUniqueUrls: 500,
    remoteImageDownloadConcurrency: 5,
    remoteImageMaxImageMiB: 80,
    remoteImageBatchMiB: 1000,
    remoteImageDownloadTimeoutSeconds: 120,
    remoteImageMaxRedirects: 0,
  };
  const settings = parseSettings(overrides);
  expect(settings).toMatchObject(overrides);
  expect(parseSettings(serializeSettings(settings))).toEqual(settings);
});

test("malformed remote image limits fall back to defaults without timer or byte overflow", () => {
  for (const invalid of [
    undefined,
    null,
    "500",
    0,
    -1,
    1.5,
    Number.NaN,
    Infinity,
    Number.MAX_VALUE,
  ]) {
    const values = Object.fromEntries(
      Object.keys(REMOTE_IMAGE_LIMIT_DEFAULTS).map((key) => [key, invalid]),
    );
    const settings = parseSettings(values);
    for (const [key, value] of Object.entries(REMOTE_IMAGE_LIMIT_DEFAULTS)) {
      expect(settings).toHaveProperty(
        key,
        key === "remoteImageMaxRedirects" && invalid === 0 ? 0 : value,
      );
    }
  }
  expect(
    parseSettings({
      remoteImageMaxImageMiB: Number.MAX_SAFE_INTEGER,
      remoteImageBatchMiB: Number.MAX_SAFE_INTEGER,
      remoteImageDownloadTimeoutSeconds: 2_147_484,
    }),
  ).toMatchObject({
    remoteImageMaxImageMiB: 20,
    remoteImageBatchMiB: 200,
    remoteImageDownloadTimeoutSeconds: 30,
  });
});
