import { expect, test } from "vite-plus/test";

import { parseSettings, remoteImageRuleScopeKey, serializeSettings } from "../src/settings";

test("new remote-image settings default to off detection without changing paste behaviour", () => {
  const settings = parseSettings({ uploadService: "uPic" });
  expect(settings.remoteImagePastePolicy).toBe("off");
  expect(settings.remoteImageAutoDetectHost).toBe(true);
  expect(settings.remoteImageHostRules).toEqual({});
  expect(settings.remoteImageAutoHostRules).toEqual({});
});

test("malformed remote-image rules are dropped without prototype pollution", () => {
  const settings = parseSettings({
    remoteImagePastePolicy: "sometimes",
    remoteImageAutoDetectHost: "yes",
    remoteImageHostRules: {
      __proto__: ["https://evil.example/"],
      "uPic:abc": [" https://cdn.example/ ", 42, ""],
      broken: "https://cdn.example/",
    },
    remoteImageAutoHostRules: {
      "uPic:abc": {
        prefixes: ["https://cdn.example/"],
        source: "uPic",
        detectedAt: "2026-10-20T00:00:00.000Z",
        fingerprint: "abc",
      },
      invalid: { prefixes: [], source: "uPic", fingerprint: "x" },
    },
  });
  expect(settings.remoteImagePastePolicy).toBe("off");
  expect(settings.remoteImageAutoDetectHost).toBe(true);
  expect(settings.remoteImageHostRules).toEqual({ "uPic:abc": ["https://cdn.example/"] });
  expect(settings.remoteImageAutoHostRules["uPic:abc"]?.source).toBe("uPic");
  expect(Object.hasOwn(settings.remoteImageAutoHostRules, "invalid")).toBe(false);
  expect(Object.hasOwn(settings.remoteImageHostRules, "__proto__")).toBe(false);
});

test("manual rules are isolated by upload service and command digest", () => {
  expect(remoteImageRuleScopeKey("uPic", "a %s")).toBe(remoteImageRuleScopeKey("uPic", "a %s"));
  expect(remoteImageRuleScopeKey("uPic", "a %s")).not.toBe(remoteImageRuleScopeKey("uPic", "b %s"));
  expect(remoteImageRuleScopeKey("uPic", "a %s")).not.toBe(
    remoteImageRuleScopeKey("Picsee", "a %s"),
  );
});

test("remote-image settings survive serialization", () => {
  const settings = parseSettings({
    remoteImagePastePolicy: "ask",
    remoteImageAutoDetectHost: false,
    remoteImageHostRules: { "custom:1": ["https://cdn.example/blog/"] },
  });
  expect(parseSettings(serializeSettings(settings))).toEqual(settings);
});
