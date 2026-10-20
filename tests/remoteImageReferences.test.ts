import { expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path,
}));

import { collectRemoteImageReferences, findRemoteImageAtOffset } from "../src/attachmentMatcher";

function targets(content: string) {
  return collectRemoteImageReferences(content).references.map((reference) => ({
    url: reference.url,
    target: content.slice(reference.targetStart, reference.targetEnd),
    token: content.slice(reference.start, reference.end),
    kind: reference.kind,
  }));
}

test("locates the destination substring inside inline images", () => {
  const content = 'x ![a](https://cdn.example/a.png "title") y ![](<https://cdn.example/b c.png>)';
  const references = collectRemoteImageReferences(content).references;
  expect(references).toHaveLength(2);
  expect(content.slice(references[0]!.targetStart, references[0]!.targetEnd)).toBe(
    "https://cdn.example/a.png",
  );
  expect(content.slice(references[1]!.targetStart, references[1]!.targetEnd)).toBe(
    "https://cdn.example/b c.png",
  );
  expect(references[1]!.targetStart - 1).toBe(content.indexOf("<https"));
});

test("resolves full, collapsed and shortcut references to the shared definition", () => {
  const content = [
    "![full][photo] ![photo][] ![photo]",
    "",
    '[photo]: <https://cdn.example/a.png> "Title"',
    "[ordinary][photo]",
  ].join("\n");
  const document = collectRemoteImageReferences(content);
  expect(document.references.map((reference) => reference.kind)).toEqual([
    "reference",
    "reference",
    "reference",
  ]);
  for (const reference of document.references) {
    expect(reference.url).toBe("https://cdn.example/a.png");
    expect(content.slice(reference.targetStart, reference.targetEnd)).toBe(
      "https://cdn.example/a.png",
    );
  }
  expect(document.references[0]!.referenceStart).toBe(content.indexOf("[photo]", 1));
  expect(document.references[1]!.referenceStart).toBe(content.indexOf("[]"));
  expect(document.references[2]!.referenceStart).toBeNull();

  const definition = document.definitions.find((item) => item.identifier === "photo")!;
  expect(definition.uses.filter((use) => use.kind === "link")).toHaveLength(1);
  expect(definition.uses.filter((use) => use.kind === "image")).toHaveLength(3);
});

test("excludes code, HTML and non-image links", () => {
  const content = [
    "`![code](https://cdn.example/a.png)`",
    "```",
    "![fenced](https://cdn.example/b.png)",
    "```",
    "<div>![html](https://cdn.example/c.png)</div>",
    "",
    "[ordinary link](https://cdn.example/d.png)",
    "",
    "![ok](https://cdn.example/e.png)",
  ].join("\n");
  expect(targets(content).map((item) => item.url)).toEqual(["https://cdn.example/e.png"]);
});

test("keeps decoded URLs while preserving escaped source destinations", () => {
  const content = String.raw`![a](https://cdn.example/a\(1\).png) ![b](https://cdn.example/%E6%88%91.png)`;
  const document = collectRemoteImageReferences(content);
  expect(document.references[0]!.url).toBe("https://cdn.example/a(1).png");
  expect(
    content.slice(document.references[0]!.targetStart, document.references[0]!.targetEnd),
  ).toBe(String.raw`https://cdn.example/a\(1\).png`);
  expect(document.references[1]!.url).toBe("https://cdn.example/%E6%88%91.png");
});

test("ignores unresolved references and local images", () => {
  const content = "![missing][nope] ![local](assets/a.png) ![remote](https://cdn.example/a.png)";
  expect(targets(content).map((item) => item.url)).toEqual(["https://cdn.example/a.png"]);
});

test("deduplicates the same URL only at the call site, not in parsing", () => {
  const content =
    "![a](https://cdn.example/a.png) ![b](https://cdn.example/a.png) ![](https://cdn.example/a.png)";
  expect(targets(content)).toHaveLength(3);
});

test("finds the image under the editor offset", () => {
  const content = "before ![a](https://cdn.example/a.png) after";
  const start = content.indexOf("![");
  expect(findRemoteImageAtOffset(content, start)?.url).toBe("https://cdn.example/a.png");
  expect(findRemoteImageAtOffset(content, content.indexOf(")"))?.url).toBe(
    "https://cdn.example/a.png",
  );
  expect(findRemoteImageAtOffset(content, content.length - 1)).toBeNull();
  expect(findRemoteImageAtOffset("no images", 1)).toBeNull();
});
