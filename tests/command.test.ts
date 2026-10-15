import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  test.skipIf(process.platform === "win32").each([0, 23])(
    "executes a wrapper safely and propagates uploader exit code %s",
    async (exitCode) => {
      const dir = mkdtempSync(join(tmpdir(), "obsidian wrapper test "));
      const wrapper = join(dir, "upload wrapper.sh");
      const tool = join(dir, "fake uploader.sh");
      const attachment = join(dir, "图片 with spaces\n$(printf injected) `printf injected`.png");
      const url = "https://example.com/uploaded.png";
      const quoteShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      try {
        writeFileSync(attachment, "attachment contents");
        writeFileSync(
          tool,
          `#!/bin/sh
set -eu
[ "$#" -eq 4 ] || exit 64
[ "$1" = '-o' ] && [ "$2" = 'url' ] && [ "$3" = '-u' ] || exit 64
printf '%s' "$4" > "$0.argument"
[ -f "$4" ] || exit 66
printf '%s\\n' 'uploader diagnostic' >&2
printf '%s\\n' '${url}'
exit ${exitCode}
`,
        );
        writeFileSync(
          wrapper,
          `#!/bin/sh
set -eu
[ "$#" -eq 1 ] || exit 64
printf '%s\\n' 'wrapper diagnostic' >&2
exec ${quoteShell(tool)} -o url -u "$1"
`,
        );
        chmodSync(tool, 0o700);
        chmodSync(wrapper, 0o700);
        let outcome: unknown;
        try {
          outcome = { stdout: await executeUploadCommand(`"${wrapper}" %s`, attachment) };
        } catch (error) {
          outcome = error;
        }
        expect(outcome).toMatchObject(
          exitCode === 0
            ? { stdout: `${url}\n` }
            : {
                code: exitCode,
                stdout: `${url}\n`,
                stderr: "wrapper diagnostic\nuploader diagnostic\n",
              },
        );
        expect(readFileSync(`${tool}.argument`, "utf8")).toBe(attachment);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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
