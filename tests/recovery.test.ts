import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Notice } from "obsidian";
import { expect, test, vi } from "vite-plus/test";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn<typeof actual.homedir>() };
});
vi.mock("obsidian", () => ({ Notice: vi.fn<(message: string, timeout?: number) => void>() }));
vi.mock("../src/lang/helpers", () => ({ t: (key: string) => key }));

import { preserveUploadReceipt, UPLOAD_RECEIPT_KEYS } from "../src/upload/recovery";

test("persists distinct private receipts with complete recovery fields and persistent notices", async () => {
  const home = await mkdtemp(join(tmpdir(), "upload-receipt-test-"));
  vi.mocked(homedir).mockReturnValue(home);
  vi.mocked(Notice).mockClear();
  try {
    const root = join(home, ".obsidian-attachment-uploader-recovery");
    // Harden a recovery root left behind with wider permissions.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root);
    await chmod(root, 0o755);
    const before = Date.now();
    await Promise.all([
      preserveUploadReceipt("https://cdn.example/a.png", "/vault/a.png", "a.png"),
      preserveUploadReceipt("https://cdn.example/b.png", "note.md", "../b.png"),
    ]);
    const directories = await readdir(root);
    expect(directories).toHaveLength(2);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const receipts: unknown[] = [];
    for (const directory of directories) {
      const path = join(root, directory, "receipt.json");
      expect(await readdir(dirname(path))).toEqual(["receipt.json"]);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const receipt = JSON.parse(await readFile(path, "utf8"));
      expect(Date.parse(receipt.timestamp)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(receipt.timestamp)).toBeLessThanOrEqual(Date.now());
      receipts.push(receipt);
      expect(Notice).toHaveBeenCalledWith(
        `${UPLOAD_RECEIPT_KEYS.saved} ${path}\n${receipt.URL}`,
        0,
      );
    }
    expect(receipts).toEqual(
      expect.arrayContaining([
        {
          URL: "https://cdn.example/a.png",
          sourcePath: "/vault/a.png",
          filename: "a.png",
          timestamp: expect.any(String),
        },
        {
          URL: "https://cdn.example/b.png",
          sourcePath: "note.md",
          filename: "../b.png",
          timestamp: expect.any(String),
        },
      ]),
    );
  } finally {
    vi.mocked(homedir).mockReset();
    await rm(home, { recursive: true, force: true });
  }
});

test("still displays the URL persistently when writing a receipt fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "upload-receipt-test-"));
  vi.mocked(Notice).mockClear();
  try {
    const blocked = join(home, "blocked");
    await writeFile(blocked, "not a directory");
    vi.mocked(homedir).mockReturnValue(blocked);
    await expect(
      preserveUploadReceipt("https://cdn.example/a.png", "note.md", "a.png"),
    ).resolves.toBeUndefined();
    expect(Notice).toHaveBeenCalledWith(
      expect.stringContaining(`${UPLOAD_RECEIPT_KEYS.failed} https://cdn.example/a.png\n`),
      0,
    );
  } finally {
    vi.mocked(homedir).mockReset();
    await rm(home, { recursive: true, force: true });
  }
});
