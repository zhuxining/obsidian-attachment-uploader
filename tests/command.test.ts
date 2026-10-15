import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { executeUploadCommand, prepareUploadCommand, splitCommand } from "../src/services/command";

describe("upload command security", () => {
  test("leaves shell syntax in filename inert", () => {
    const path = '/tmp/with $(whoami) `id` " quotes.png';
    expect(prepareUploadCommand("uPic -o url -u %s", path)).toEqual({
      executable: "uPic",
      args: ["-o", "url", "-u", path],
    });
  });
  test("supports a quoted executable", () => {
    expect(
      prepareUploadCommand(
        '"/Applications/Picsee App.app/Contents/MacOS/Picsee" -u %s',
        "/tmp/a.png",
      ),
    ).toEqual({
      executable: "/Applications/Picsee App.app/Contents/MacOS/Picsee",
      args: ["-u", "/tmp/a.png"],
    });
  });
  test("rejects shell-control suffixes and malformed placeholders", () => {
    expect(splitCommand("uPic -u %s; rm -rf /tmp/example")).toContain("%s;");
    for (const command of [
      "uPic -u %s; rm -rf /tmp/example",
      "uPic --file=%s",
      "uPic -u",
      "uPic -u %s %s",
    ])
      expect(() => prepareUploadCommand(command, "/tmp/a.png")).toThrow(
        "Upload command must contain exactly one standalone %s argument",
      );
  });
  test("rejects unterminated quotes", () => {
    expect(() => splitCommand('"uPic -u %s')).toThrow("Unclosed quote in upload command");
  });
  test.skipIf(process.platform === "win32")("does not evaluate malicious filename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obsidian-uploader-test-"));
    const sentinel = join(dir, "should-not-exist");
    const crafted = `image$(touch ${sentinel}).png`;
    try {
      expect(await executeUploadCommand("/bin/echo -n %s", crafted)).toBe(crafted);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
