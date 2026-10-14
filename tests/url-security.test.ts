import { describe, expect, test } from "vite-plus/test";
import { extractUrl, toMarkdownUrl } from "../src/services/url";

describe("safe upload URL handling", () => {
  test("extracts uPic output", () => {
    expect(extractUrl("Output URL:\nhttps://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(extractUrl("result: https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
  });
  test("rejects incidental documentation URL", () => {
    expect(extractUrl("Failed, see https://help.example.com")).toBeNull();
  });
  test("preserves encoded delimiters", () => {
    expect(toMarkdownUrl("https://cdn.example.com/c%2523d%253Fe.png"))
      .toBe("https://cdn.example.com/c%23d%3Fe.png");
  });
  test("normalizes mixed Unicode encoding", () => {
    expect(toMarkdownUrl("https://cdn.example.com/我的 图%20(1).png"))
      .toBe("<https://cdn.example.com/%E6%88%91%E7%9A%84%20%E5%9B%BE%20(1).png>");
  });
});
