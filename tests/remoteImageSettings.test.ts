import { expect, test } from "vite-plus/test";

import { parseSettings, serializeSettings } from "../src/settings";

test("remote transfers default to manual with no skipped prefixes", () => {
  const settings = parseSettings(null);
  expect(settings.autoTransferRemoteImages).toBe(false);
  expect(settings.remoteImageSkipPrefixes).toEqual([]);
});

test("validates and round-trips the two remote image settings", () => {
  const settings = parseSettings({
    autoTransferRemoteImages: true,
    remoteImageSkipPrefixes: [" https://cdn.example/blog/ ", 42, ""],
  });
  expect(settings.remoteImageSkipPrefixes).toEqual(["https://cdn.example/blog/"]);
  expect(parseSettings(serializeSettings(settings))).toEqual(settings);
  expect(
    parseSettings({ autoTransferRemoteImages: "true", remoteImageSkipPrefixes: {} })
      .autoTransferRemoteImages,
  ).toBe(false);
});

test("drops removed PR settings instead of persisting compatibility rules", () => {
  const settings = serializeSettings(
    parseSettings({
      remoteImagePastePolicy: "ask",
      remoteImageMaxUniqueUrls: 500,
      remoteImageAutoDetectHost: true,
      remoteImageHostRules: { old: ["https://old.example/"] },
    }),
  );
  expect(settings).not.toHaveProperty("remoteImagePastePolicy");
  expect(settings).not.toHaveProperty("remoteImageMaxUniqueUrls");
  expect(settings).not.toHaveProperty("remoteImageAutoDetectHost");
  expect(settings).not.toHaveProperty("remoteImageHostRules");
});
