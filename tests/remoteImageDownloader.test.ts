import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, vi } from "vite-plus/test";

vi.mock("obsidian", () => ({}));

import {
  RemoteImageDownloader,
  RemoteImageDownloadError,
  sniffImageType,
} from "../src/upload/imageDownloader";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withServer(handler: Handler, run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

test("streams an image to an isolated temporary file", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
      response.end(PNG);
    },
    async (base) => {
      const downloader = new RemoteImageDownloader();
      try {
        const result = await downloader.download(`${base}/image-without-extension`);
        expect(result.extension).toBe("png");
        expect(result.bytes).toBe(PNG.length);
        expect(await readFile(result.path)).toEqual(PNG);
        expect(result.path).toContain("obsidian-attachment-uploader-remote-");
        await downloader.release(result.path);
        await expect(readFile(result.path)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await downloader.dispose();
      }
    },
  );
});

test("follows a redirect and re-validates the destination", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/final.gif" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "image/gif" });
      response.end(Buffer.from("GIF89a", "latin1"));
    },
    async (base) => {
      const downloader = new RemoteImageDownloader();
      try {
        const result = await downloader.download(`${base}/start`);
        expect(result.extension).toBe("gif");
      } finally {
        await downloader.dispose();
      }
    },
  );
});

test("refuses to exceed the redirect limit", async () => {
  expect.hasAssertions();
  await withServer(
    (request, response) => {
      response.writeHead(302, { location: request.url === "/a" ? "/b" : "/a" });
      response.end();
    },
    async (base) => {
      const downloader = new RemoteImageDownloader({
        maxRedirects: 1,
      });
      try {
        await expectCode(downloader.download(`${base}/a`), "http-status");
      } finally {
        await downloader.dispose();
      }
    },
  );
});

test("rejects an HTML login page even when it is labelled as an image", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end("<!doctype html><html><body>sign in</body></html>");
    },
    async (base) => {
      const downloader = new RemoteImageDownloader();
      try {
        await expectCode(downloader.download(`${base}/login.png`), "not-an-image");
        expect(await downloader.release(`${base}/none`)).toBeUndefined();
      } finally {
        await downloader.dispose();
      }
    },
  );
});

test("enforces the per-image size limit before buffering the whole body", async () => {
  expect.hasAssertions();
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
      response.end(PNG);
    },
    async (base) => {
      const downloader = new RemoteImageDownloader({
        maxBytes: 10,
      });
      try {
        await expectCode(downloader.download(`${base}/big.png`), "too-large");
      } finally {
        await downloader.dispose();
      }
    },
  );
});

test("enforces the shared batch budget across downloads", async () => {
  expect.hasAssertions();
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
    },
    async (base) => {
      const downloader = new RemoteImageDownloader();
      const budget = { used: 0, limit: PNG.length + 10 };
      try {
        await downloader.download(`${base}/one.png`, { budget });
        await expectCode(downloader.download(`${base}/two.png`, { budget }), "batch-limit");
      } finally {
        await downloader.dispose();
      }
    },
  );
});

test("downloads loopback image sources without a special address policy", async () => {
  expect.hasAssertions();
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
    },
    async (base) => {
      const downloader = new RemoteImageDownloader();
      try {
        const image = await downloader.download(`${base}/a.png`);
        expect(await readFile(image.path)).toEqual(PNG);
      } finally {
        await downloader.dispose();
      }
    },
  );
});

test("aborts an in-progress download", async () => {
  expect.hasAssertions();
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.write(PNG.subarray(0, 8));
    },
    async (base) => {
      const downloader = new RemoteImageDownloader();
      const controller = new AbortController();
      try {
        const operation = downloader.download(`${base}/slow.png`, {
          signal: controller.signal,
          timeoutMs: 5_000,
        });
        setTimeout(() => controller.abort(), 20);
        await expectCode(operation, "aborted");
      } finally {
        await downloader.dispose();
      }
    },
  );
});

test("times out a stalled connection", async () => {
  expect.hasAssertions();
  await withServer(
    () => {
      // Never respond.
    },
    async (base) => {
      const downloader = new RemoteImageDownloader();
      try {
        await expectCode(downloader.download(`${base}/stall.png`, { timeoutMs: 40 }), "timeout");
      } finally {
        await downloader.dispose();
      }
    },
  );
});

test("sniffs supported image signatures and rejects unknown responses", () => {
  expect(sniffImageType(Buffer.from("GIF89a"), "image/gif")?.extension).toBe("gif");
  expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "image/jpeg")?.extension).toBe(
    "jpg",
  );
  expect(sniffImageType(Buffer.from("BMxxxx"), "image/bmp")?.extension).toBe("bmp");
  expect(sniffImageType(Buffer.from("RIFF0000WEBPVP8 ", "latin1"), "image/webp")?.extension).toBe(
    "webp",
  );
  expect(sniffImageType(Buffer.from("0000ftypavif0000", "latin1"), "image/avif")?.extension).toBe(
    "avif",
  );
  expect(
    sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "text/plain")
      ?.extension,
  ).toBe("svg");
  expect(
    sniffImageType(
      Buffer.from('<?xml version="1.0"?><!-- logo --><svg xmlns="x"></svg>'),
      "image/svg+xml",
    )?.extension,
  ).toBe("svg");
  expect(sniffImageType(Buffer.from("just text"), "text/plain")).toBeNull();
  expect(sniffImageType(Buffer.from("<html></html>"), "image/png")).toBeNull();
  expect(
    sniffImageType(Buffer.from("<meta charset=utf-8><svg></svg>"), "image/svg+xml"),
  ).toBeNull();
});

test("exposes a typed error for unsupported URL schemes", async () => {
  const downloader = new RemoteImageDownloader();
  try {
    await expect(downloader.download("file:///etc/passwd")).rejects.toBeInstanceOf(
      RemoteImageDownloadError,
    );
  } finally {
    await downloader.dispose();
  }
});

// A gzip header without an end marker leaves the decoder waiting indefinitely
// unless abort/premature-close is propagated through the entire stream chain.
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);

test.each(["timeout", "aborted"])("settles and cleans a stalled gzip body on %s", async (code) => {
  await withServer(
    (request, response) => {
      if (request.url === "/healthy") {
        response.end(PNG);
        return;
      }
      response.writeHead(200, { "content-encoding": "gzip" });
      response.write(GZIP_HEADER);
    },
    async (base) => {
      const downloader = new RemoteImageDownloader();
      const controller = new AbortController();
      const timer = code === "aborted" ? setTimeout(() => controller.abort(), 60) : undefined;
      try {
        await expectCode(
          downloader.download(`${base}/stall`, {
            signal: controller.signal,
            timeoutMs: code === "timeout" ? 60 : 2000,
          }),
          code,
        );
        // Reusing the downloader also proves the failed download didn't block it.
        const next = await downloader.download(`${base}/healthy`);
        expect(await readFile(next.path)).toEqual(PNG);
        const { readdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        expect(
          (await readdir(dirname(next.path))).filter((file) => file.endsWith(".part")),
        ).toEqual([]);
      } finally {
        clearTimeout(timer);
        await downloader.dispose();
      }
    },
  );
});

test("settles when a compressed response disconnects prematurely", async () => {
  expect.hasAssertions();
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip" });
      response.write(GZIP_HEADER);
      setTimeout(() => response.destroy(), 30);
    },
    async (base) => {
      const downloader = new RemoteImageDownloader();
      try {
        await expectCode(downloader.download(base, { timeoutMs: 2000 }), "network");
      } finally {
        await downloader.dispose();
      }
    },
  );
});
