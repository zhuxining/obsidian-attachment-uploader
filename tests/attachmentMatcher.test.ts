import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path.replace(/\\\\/g, "/"),
}));

import { AttachmentMatcher } from "../src/attachmentMatcher";

function createMatcher(paths: string[], resolved?: string) {
  const files = paths.map((path) => {
    const name = path.split("/").at(-1)!;
    return { path, name };
  });
  const matcher = new AttachmentMatcher({
    vault: { getFiles: () => files, adapter: { getBasePath: () => "/notes" } },
    metadataCache: { getFirstLinkpathDest: () => files.find((file) => file.path === resolved) ?? null },
  } as never);
  return matcher;
}

describe("attachment identity and parsing", () => {
  test("never picks an arbitrary file when basenames collide", () => {
    const matcher = createMatcher(["images/a.png", "other/a.png"]);
    const result = matcher.getEditorAttachments({ editor: { getValue: () => "![[a.png]]" } });
    expect(result[0]?.existenceState).toBe("missing");
  });
  test("uses context-aware metadata resolution", () => {
    const matcher = createMatcher(["images/a.png", "other/a.png"], "other/a.png");
    const result = matcher.getEditorAttachments({ editor: { getValue: () => "![[a.png|300]]" } });
    expect(result[0]?.inVaultPath).toBe("other/a.png");
  });
  test("handles parenthesized names without treating wiki links as markdown", () => {
    const matcher = createMatcher(["assets/a(1).png"]);
    const result = matcher.getEditorAttachments({ editor: { getValue: () => "![[a(1).png]]" } });
    expect(result[0]?.inVaultPath).toBe("assets/a(1).png");
  });
});
