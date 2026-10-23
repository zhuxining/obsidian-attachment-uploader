import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path,
}));

import { applyTextChanges, type TextChange } from "../src/attachments/imageRewriter";
import { RemoteImageDownloader } from "../src/upload/imageDownloader";
import { ImageTransferService, type TransferDocumentAccess } from "../src/upload/remoteImages";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(128, 2),
]);

test("downloads, uploads and rewrites duplicate references end to end", async () => {
  const server = createServer((_request, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
    response.end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const downloader = new RemoteImageDownloader();
  let content = "";
  const document: TransferDocumentAccess = {
    read: async () => ({ content, live: true }),
    apply: async (base: string, changes: readonly TextChange[]) => {
      if (content !== base) return false;
      content = applyTextChanges(base, changes);
      return true;
    },
  };
  const uploaded: string[] = [];
  let uploadCount = 0;
  const preserveReceipt = vi.fn<() => Promise<void>>(async () => {});
  try {
    const base = `http://127.0.0.1:${address.port}`;
    content = `before ![](${base}/one.png) middle ![](${base}/one.png) after`;
    const service = new ImageTransferService({
      document,
      downloader,
      upload: async (path: string) => {
        expect((await readFile(path)).equals(PNG)).toBe(true);
        uploaded.push(path);
        uploadCount += 1;
        return { success: true, url: "https://cdn.example/uploaded.png" };
      },
      preserveReceipt,
      sessionOutputs: new Set<string>(),
    });
    const summary = await service.transfer({
      sourcePath: "note.md",
      scope: { kind: "note" },
      settings: { uploadFileFormat: new Set([".png"]), prefixes: [] },
      signal: new AbortController().signal,
    });

    expect(uploadCount).toBe(1);
    expect(uploaded[0]).toMatch(/\.png$/);
    expect(content).toBe(
      "before ![](https://cdn.example/uploaded.png) middle ![](https://cdn.example/uploaded.png) after",
    );
    expect(summary).toMatchObject({
      totalReferences: 2,
      uniqueUrls: 1,
      succeeded: 1,
      failed: 0,
      notApplied: 0,
    });
    expect(preserveReceipt).not.toHaveBeenCalled();
    await expect(readFile(uploaded[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await downloader.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("keeps the original link when the server returns an HTML page", async () => {
  const server = createServer((_request, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end("<!doctype html><html><body>login</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const downloader = new RemoteImageDownloader();
  let content = `![](http://127.0.0.1:${address.port}/login.png)`;
  const uploaded: string[] = [];
  const preserveReceipt = vi.fn<() => Promise<void>>(async () => {});
  try {
    const service = new ImageTransferService({
      document: {
        read: async () => ({ content, live: true }),
        apply: async (base, changes) => {
          if (content !== base) return false;
          content = applyTextChanges(base, changes);
          return true;
        },
      },
      downloader,
      upload: async (path) => {
        uploaded.push(path);
        return { success: true, url: "https://cdn.example/uploaded.png" };
      },
      preserveReceipt,
      sessionOutputs: new Set<string>(),
    });
    const summary = await service.transfer({
      sourcePath: "note.md",
      scope: { kind: "note" },
      settings: { uploadFileFormat: new Set([".png"]), prefixes: [] },
      signal: new AbortController().signal,
    });
    expect(uploaded).toEqual([]);
    expect(content).toBe(`![](http://127.0.0.1:${address.port}/login.png)`);
    expect(summary.failed).toBe(1);
    expect(summary.errors[0]?.code).toBe("not-an-image");
    expect(preserveReceipt).not.toHaveBeenCalled();
  } finally {
    await downloader.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
