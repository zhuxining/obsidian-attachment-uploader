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
    metadataCache: {
      getFirstLinkpathDest: () => files.find((file) => file.path === resolved) ?? null,
    },
  } as never);
  return matcher;
}

describe("attachment identity and parsing", () => {
  test("ignores fenced code, inline code and comments while keeping source offsets", () => {
    const matcher = createMatcher(["assets/a.png"], "assets/a.png");
    const source = "![[assets/a.png]]";
    const content = ["```md", source, "```", `\`${source}\``, `<!-- ${source} -->`, source].join(
      "\n",
    );
    const attachments = matcher.getEditorAttachments({ editor: { getValue: () => content } });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.start).toBe(content.lastIndexOf(source));
    expect(content.slice(attachments[0]!.start, attachments[0]!.end)).toBe(source);
  });

  test("does not scan vault files when metadata resolution is available", () => {
    const getFiles = vi.fn<() => never[]>(() => []);
    const resolve = vi.fn<() => { path: string; name: string }>(() => ({
      path: "assets/a.png",
      name: "a.png",
    }));
    const matcher = new AttachmentMatcher({
      vault: { getFiles, adapter: { getBasePath: () => "/vault" } },
      metadataCache: { getFirstLinkpathDest: resolve },
    } as never);
    matcher.getEditorAttachments({
      editor: { getValue: () => "![[a.png]] ![](https://cdn.example/a.png)" },
    });
    expect(getFiles).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

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
    const matcher = createMatcher(["assets/a(1).png"], "assets/a(1).png");
    const result = matcher.getEditorAttachments({ editor: { getValue: () => "![[a(1).png]]" } });
    expect(result[0]?.inVaultPath).toBe("assets/a(1).png");
  });
  test("recognizes escaped closing brackets in image descriptions", () => {
    const matcher = createMatcher(["assets/a.png"], "assets/a.png");
    const source = "![a\\]b](assets/a.png)";
    const result = matcher.getEditorAttachments({ editor: { getValue: () => source } });
    expect(result[0]?.source).toBe(source);
    expect(result[0]?.inVaultPath).toBe("assets/a.png");
  });
  test("does not override a failed metadata resolution with a basename match", () => {
    const matcher = createMatcher(["assets/a.png"]);
    const result = matcher.getEditorAttachments({
      editor: { getValue: () => "![](missing/a.png)" },
    });
    expect(result[0]?.existenceState).toBe("missing");
  });
});
