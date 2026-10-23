import { expect, test } from "vite-plus/test";

import { applyTextChanges, buildRemoteImageReplacements } from "../src/attachments/imageRewriter";
import { collectRemoteImageReferences } from "../src/attachments/markdown";

function rewrite(content: string, replacements: Record<string, string>, all = true) {
  const document = collectRemoteImageReferences(content);
  const plan = buildRemoteImageReplacements(
    content,
    document,
    new Map(Object.entries(replacements)),
    () => all,
  );
  expect(plan).not.toBeNull();
  return {
    content: plan!.changes.length ? applyTextChanges(content, plan!.changes) : content,
    applied: plan!.appliedUrls,
  };
}

test("rewrites only the destination and preserves title and alt syntax", () => {
  const result = rewrite('![**alt**](https://cdn.example/a.png "A title")', {
    "https://cdn.example/a.png": "https://cdn.example/uploaded.png",
  });
  expect(result.content).toBe('![**alt**](https://cdn.example/uploaded.png "A title")');
});

test("preserves angle-bracket destinations and encodes new special characters", () => {
  const result = rewrite("![](<https://cdn.example/a b.png>)", {
    "https://cdn.example/a b.png": "https://cdn.example/new (1).png",
  });
  expect(result.content).toBe("![](<https://cdn.example/new%20(1).png>)");
});

test("replaces a definition when every use is an in-scope image", () => {
  const content = '![a][photo]\n\n[photo]: https://cdn.example/a.png "Title"\n';
  const result = rewrite(content, { "https://cdn.example/a.png": "https://cdn.example/b.png" });
  expect(result.content).toBe('![a][photo]\n\n[photo]: https://cdn.example/b.png "Title"\n');
});

test("inlines the image when an ordinary link shares its definition", () => {
  const content = [
    "![a][photo] [download][photo]",
    "",
    '[photo]: <https://cdn.example/a.png> "Title"',
    "",
  ].join("\n");
  const result = rewrite(content, { "https://cdn.example/a.png": "https://cdn.example/b.png" });
  expect(result.content).toBe(
    [
      '![a](https://cdn.example/b.png "Title") [download][photo]',
      "",
      '[photo]: <https://cdn.example/a.png> "Title"',
      "",
    ].join("\n"),
  );
});

test("inlines collapsed and shortcut images while preserving the shared definition", () => {
  const content = [
    "![photo][] and ![photo] plus [link][photo]",
    "",
    "[photo]: https://cdn.example/a.png",
    "",
  ].join("\n");
  const result = rewrite(content, { "https://cdn.example/a.png": "https://cdn.example/b.png" });
  expect(result.content).toBe(
    [
      "![photo](https://cdn.example/b.png) and ![photo](https://cdn.example/b.png) plus [link][photo]",
      "",
      "[photo]: https://cdn.example/a.png",
      "",
    ].join("\n"),
  );
});

test("only rewrites the selection and leaves out-of-scope images untouched", () => {
  const content = [
    "![one][photo]",
    "",
    "![two][photo]",
    "",
    "[photo]: https://cdn.example/a.png",
    "",
  ].join("\n");
  const document = collectRemoteImageReferences(content);
  const second = document.references[1]!;
  const plan = buildRemoteImageReplacements(
    content,
    document,
    new Map([["https://cdn.example/a.png", "https://cdn.example/b.png"]]),
    (start, end) => start >= second.start && end <= second.end,
  );
  expect(plan).not.toBeNull();
  const updated = applyTextChanges(content, plan!.changes);
  expect(updated).toBe(
    [
      "![one][photo]",
      "",
      "![two](https://cdn.example/b.png)",
      "",
      "[photo]: https://cdn.example/a.png",
      "",
    ].join("\n"),
  );
});

test("applies one URL replacement to every duplicate reference", () => {
  const content =
    "![](https://cdn.example/a.png) ![](https://cdn.example/a.png) ![](https://cdn.example/a.png)";
  const result = rewrite(content, { "https://cdn.example/a.png": "https://cdn.example/b.png" });
  expect(result.content).toBe(
    "![](https://cdn.example/b.png) ![](https://cdn.example/b.png) ![](https://cdn.example/b.png)",
  );
  expect([...result.applied]).toEqual(["https://cdn.example/a.png"]);
});

test("applies changes from the end so earlier offsets stay valid", () => {
  const content = "a b c";
  const updated = applyTextChanges(content, [
    { start: 0, end: 1, text: "AAA" },
    { start: 2, end: 3, text: "BBB" },
    { start: 4, end: 5, text: "CCC" },
  ]);
  expect(updated).toBe("AAA BBB CCC");
});

test("rejects overlapping changes instead of corrupting the document", () => {
  const content = "![](https://cdn.example/a.png)";
  const document = collectRemoteImageReferences(content);
  const duplicate = {
    ...document,
    definitions: document.definitions,
    references: [...document.references, ...document.references],
  };
  const plan = buildRemoteImageReplacements(
    content,
    duplicate,
    new Map([["https://cdn.example/a.png", "https://cdn.example/b.png"]]),
    () => true,
  );
  expect(plan).toBeNull();
});
