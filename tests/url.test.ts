import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { extractUrl, toMarkdownUrl } from "../src/services/url";

// 真实 uPic 输出：URL 独占一行，位于 "Output URL:" 之后
const UPIC_STDOUT = [
  "共 1 个文件路径和链接",
  "Uploading ...",
  "Uploading 1/1",
  "Output URL:",
  "https://r-w.oss-cn-shanghai.aliyuncs.com/uPic/test_upload.png?x-oss-process=image/auto-orient,1/quality,q_80/format,webp",
].join("\n");

const UPIC_URL =
  "https://r-w.oss-cn-shanghai.aliyuncs.com/uPic/test_upload.png?x-oss-process=image/auto-orient,1/quality,q_80/format,webp";

describe("extractUrl", () => {
  test("真实 uPic 输出：抓到完整 URL（含 ? = , 等特殊字符）", () => {
    expect(extractUrl(UPIC_STDOUT)).toBe(UPIC_URL);
  });

  test("URL 含空格：不被截断，取到行尾", () => {
    const stdout = "Uploaded:\nhttps://cdn.example.com/my photo (1).png";
    expect(extractUrl(stdout)).toBe("https://cdn.example.com/my photo (1).png");
  });

  test("URL 被双引号包裹：去掉引号", () => {
    expect(extractUrl('"https://cdn.example.com/a.png"')).toBe("https://cdn.example.com/a.png");
  });

  test("URL 被单引号包裹：去掉引号", () => {
    expect(extractUrl("'https://cdn.example.com/a.png'")).toBe("https://cdn.example.com/a.png");
  });

  test("没有 URL：返回 null", () => {
    expect(extractUrl("upload failed: unknown error")).toBeNull();
  });

  test("http（非 https）也能提取", () => {
    expect(extractUrl("result: http://example.com/x.png")).toBe("http://example.com/x.png");
  });
});

describe("toMarkdownUrl", () => {
  test("普通 URL：原样返回，不做多余包裹", () => {
    expect(toMarkdownUrl(UPIC_URL)).toBe(UPIC_URL);
  });

  test("含括号的 URL：用尖括号包裹，避免撑破 Markdown 链接", () => {
    expect(toMarkdownUrl("https://cdn.example.com/a(1).png")).toBe(
      "<https://cdn.example.com/a(1).png>",
    );
  });

  test("含空格的 URL：空格编码为 %20（裸链接不会断裂，故不包裹）", () => {
    expect(toMarkdownUrl("https://cdn.example.com/my photo.png")).toBe(
      "https://cdn.example.com/my%20photo.png",
    );
  });

  test("含尖括号：encodeURI 编码为 %3C/%3E，裸链接安全，不包裹", () => {
    expect(toMarkdownUrl("https://cdn.example.com/a<b>.png")).toBe(
      "https://cdn.example.com/a%3Cb%3E.png",
    );
  });

  test("已编码的 URL：不二次编码", () => {
    expect(toMarkdownUrl("https://cdn.example.com/my%20photo.png")).toBe(
      "https://cdn.example.com/my%20photo.png",
    );
  });
});

// 集成测试：若本机安装了 uPic，则真实跑一次上传命令，验证端到端解析。
const UPIC_BIN = "/Applications/uPic.app/Contents/MacOS/uPic";
const uPicAvailable = (() => {
  try {
    execFileSync("test", ["-x", UPIC_BIN]);
    return true;
  } catch {
    return false;
  }
})();

// 集成测试会真实上传一张测试图到你的 uPic 后端（产生云端文件），默认关闭。
// 需要跑时：RUN_INTEGRATION_TESTS=1 npm test
test.skipIf(!uPicAvailable || !process.env.RUN_INTEGRATION_TESTS)(
  "集成：真实运行 uPic 并解析输出",
  () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const tmp = join(tmpdir(), `obs-upload-test-${Date.now()}.png`);
    writeFileSync(tmp, png);

    const stdout = execFileSync(UPIC_BIN, ["-o", "url", "-u", tmp], {
      encoding: "utf8",
    });
    const url = extractUrl(stdout);
    expect(url).not.toBeNull();
    expect(url!.startsWith("http")).toBe(true);
    // 生成的 Markdown 链接必须是合法可用的
    expect(toMarkdownUrl(url!)).toMatch(/^<?https?:\/\/\S+>?$/);
  },
);
