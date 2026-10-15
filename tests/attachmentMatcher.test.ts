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
  test.each([
    ['![caption](assets/a.png "A title")', "assets/a.png", "caption"],
    ["![caption](assets/a.png 'A title')", "assets/a.png", "caption"],
    ["![caption](assets/a.png (A title))", "assets/a.png", "caption"],
    ["![caption](assets/a(b(c)).png)", "assets/a(b(c)).png", "caption"],
    [String.raw`![a\]b](assets/a\(1\).png)`, "assets/a(1).png", "a]b"],
    ['![caption](<assets/a b.png> "A title")', "assets/a b.png", "caption"],
    ["![caption](assets/a&amp;b.png)", "assets/a&b.png", "caption"],
  ])("parses standard image %s", (source, path, alt) => {
    const matcher = createMatcher([path], path);
    const result = matcher.getEditorAttachments({ editor: { getValue: () => source } });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source,
      start: 0,
      end: source.length,
      alt,
      inVaultPath: path,
      existenceState: "local",
    });
  });

  test("resolves full, collapsed and shortcut references without replacing definitions", () => {
    const matcher = createMatcher(["assets/a(1).png"], "assets/a(1).png");
    const sources = ["![full][PHOTO]", "![photo][]", "![photo]"];
    const content = `${sources.join(" ")}\n\n[photo]: <assets/a(1).png> "Title"\n`;
    const result = matcher.getEditorAttachments({ editor: { getValue: () => content } });
    expect(result.map((attachment) => attachment.source)).toEqual(sources);
    for (const attachment of result) {
      expect(attachment.inVaultPath).toBe("assets/a(1).png");
      expect(content.slice(attachment.start, attachment.end)).toBe(attachment.source);
    }
  });

  test("uses the first reference definition and ignores unresolved references", () => {
    const matcher = createMatcher([]);
    const content = "![a][id] ![missing]\n\n[id]: first.png\n[id]: second.png";
    const result = matcher.getEditorAttachments({ editor: { getValue: () => content } });
    expect(result).toHaveLength(1);
    expect(result[0]?.inVaultPath).toBe("first.png");
  });

  test("preserves UTF-16 offsets across emoji, CRLF and reference syntax", () => {
    const matcher = createMatcher(["assets/a.png"], "assets/a.png");
    const sources = ['![😀](assets/a.png "标题")', "![[assets/a.png|宽度]]", "![图片][id]"];
    const content = `😀前缀 ${sources[0]}\r\n\r\n中文😀 ${sources[1]} ${sources[2]}\r\n\r\n[id]: assets/a.png`;
    const result = matcher.getEditorAttachments({ editor: { getValue: () => content } });
    expect(result.map((attachment) => attachment.source)).toEqual(sources);
    for (const [index, attachment] of result.entries()) {
      expect(attachment.start).toBe(content.indexOf(sources[index]!));
      expect(attachment.end).toBe(attachment.start + sources[index]!.length);
      expect(content.slice(attachment.start, attachment.end)).toBe(sources[index]);
    }
  });

  test.each([
    "    ![[a.png]] ![](a.png)",
    "\t![[a.png]] ![](a.png)",
    ">     ![[a.png]] ![](a.png)",
    "~~~md\n![[a.png]] ![](a.png)\n~~~",
    "`` ![[a.png]] ` ![](a.png) ``",
    "<!-- ![[a.png]] ![](a.png) -->",
    '<img src="![[a.png]]">',
    "<div>\n![[a.png]] ![](a.png)\n</div>",
    "<span>![[a.png]] ![](a.png)</span>",
    String.raw`\![[a.png]] \![](a.png)`,
  ])("excludes code, HTML and escaped embeds: %s", (example) => {
    const matcher = createMatcher(["a.png"], "a.png");
    const source = "![[a.png]]";
    const content = `${example}\n\n${source}`;
    const result = matcher.getEditorAttachments({ editor: { getValue: () => content } });
    expect(result).toHaveLength(1);
    expect(result[0]?.start).toBe(content.lastIndexOf(source));
  });

  test("does not scan Wiki embeds inside standard image alt or reference alt", () => {
    const matcher = createMatcher(["outer.png"], "outer.png");
    const content = "![![[inner.png]]](outer.png) ![![[inner.png]]][id]\n\n[id]: outer.png";
    const result = matcher.getEditorAttachments({ editor: { getValue: () => content } });
    expect(result.map((attachment) => attachment.source)).toEqual([
      "![![[inner.png]]](outer.png)",
      "![![[inner.png]]][id]",
    ]);
  });

  test("accepts embeds after an even number of escape backslashes", () => {
    const matcher = createMatcher(["a.png"], "a.png");
    const content = String.raw`\\![[a.png]] \\![](a.png)`;
    const result = matcher.getEditorAttachments({ editor: { getValue: () => content } });
    expect(result.map((attachment) => attachment.source)).toEqual(["![[a.png]]", "![](a.png)"]);
  });

  test("keeps exact-path and unique-basename fallback without metadata", () => {
    const files = ["one/a.png", "two/a.png", "assets/b.png"].map((path) => ({
      path,
      name: path.split("/").at(-1)!,
    }));
    const matcher = new AttachmentMatcher({
      vault: { getFiles: () => files, adapter: { getBasePath: () => "/notes" } },
    } as never);
    const result = matcher.getEditorAttachments({
      editor: { getValue: () => "![](one/a.png) ![[a.png]] ![b][id]\n\n[id]: b.png" },
    });
    expect(result.map((attachment) => [attachment.existenceState, attachment.inVaultPath])).toEqual(
      [
        ["local", "one/a.png"],
        ["missing", "a.png"],
        ["local", "assets/b.png"],
      ],
    );
  });

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

  test("passes decoded destinations and the note path to authoritative metadata resolution", () => {
    const resolve = vi.fn<(path: string, notePath: string) => null>(() => null);
    const matcher = new AttachmentMatcher({
      vault: { getFiles: () => [], adapter: { getBasePath: () => "/notes" } },
      metadataCache: { getFirstLinkpathDest: resolve },
    } as never);
    matcher.getEditorAttachments({
      editor: {
        getValue: () => String.raw`![a](../assets/a\(1\)%20b.png "Title") ![b][id]

[id]: ../assets/b.png "Other title"`,
      },
      file: { path: "folder/note.md" } as never,
    });
    expect(resolve.mock.calls).toEqual([
      ["../assets/a(1) b.png", "folder/note.md"],
      ["../assets/b.png", "folder/note.md"],
    ]);
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
