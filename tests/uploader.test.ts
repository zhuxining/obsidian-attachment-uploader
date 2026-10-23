import { expect, test, vi } from "vite-plus/test";

import { Uploader, UploadCancelledError } from "../src/upload/uploader";

test("serializes commands across different callers and snapshots each command", async () => {
  let finish!: (stdout: string) => void;
  const execute = vi
    .fn<(command: string, path: string) => Promise<string>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue("https://cdn.example/result.png");
  const uploader = new Uploader(execute);
  const first = uploader.uploadFile("/local.png", { command: "old %s" });
  const second = uploader.uploadFile("/remote.png", { command: "old %s" });
  const third = uploader.uploadFile("/pasted.png", { command: "new %s" });
  expect(execute.mock.calls).toEqual([["old %s", "/local.png"]]);
  finish("Output URL: https://cdn.example/first.png");
  await Promise.all([first, second, third]);
  expect(execute.mock.calls).toEqual([
    ["old %s", "/local.png"],
    ["old %s", "/remote.png"],
    ["new %s", "/pasted.png"],
  ]);
});

test("deduplicates an in-flight file in the same cancellation scope", async () => {
  let finish!: (stdout: string) => void;
  const execute = vi.fn<() => Promise<string>>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const uploader = new Uploader(execute);
  const controller = new AbortController();
  const options = { command: "uploader %s", signal: controller.signal };
  const first = uploader.uploadFile("/same.png", options);
  const second = uploader.uploadFile("/same.png", options);
  expect(execute).toHaveBeenCalledOnce();
  finish("https://cdn.example/same.png");
  expect(await first).toEqual(await second);
});

test("cancels a queued caller without cancelling other requests for the same file", async () => {
  let finish!: (stdout: string) => void;
  const execute = vi
    .fn<() => Promise<string>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue("https://cdn.example/same.png");
  const uploader = new Uploader(execute);
  const blocker = uploader.uploadFile("/blocker.png", { command: "uploader %s" });
  const cancelled = new AbortController();
  const survivor = new AbortController();
  const second = uploader.uploadFile("/same.png", {
    command: "uploader %s",
    signal: cancelled.signal,
  });
  const third = uploader.uploadFile("/same.png", {
    command: "uploader %s",
    signal: survivor.signal,
  });
  cancelled.abort();
  await expect(second).rejects.toBeInstanceOf(UploadCancelledError);
  finish("https://cdn.example/blocker.png");
  await blocker;
  await expect(third).resolves.toEqual({ success: true, url: "https://cdn.example/same.png" });
  expect(execute).toHaveBeenCalledTimes(2);
});

test("running commands finish after cancellation so callers can preserve their result", async () => {
  let finish!: (stdout: string) => void;
  const uploader = new Uploader(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = uploader.uploadFile("/running.png", {
    command: "uploader %s",
    signal: controller.signal,
  });
  controller.abort();
  finish("https://cdn.example/running.png");
  await expect(pending).resolves.toEqual({ success: true, url: "https://cdn.example/running.png" });
});

test("invalid output and failed commands do not block later uploads", async () => {
  const execute = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce("https://cdn.example/one.png\nhttps://cdn.example/two.png")
    .mockRejectedValueOnce(new Error("tool offline"))
    .mockResolvedValueOnce("Output URL: https://cdn.example/ok.png");
  const uploader = new Uploader(execute);
  const results = await Promise.all(
    ["/one.png", "/two.png", "/three.png"].map((path) =>
      uploader.uploadFile(path, { command: "uploader %s" }),
    ),
  );
  expect(results).toEqual([
    { success: false, errorMessage: "No valid upload URL was returned" },
    { success: false, errorMessage: "tool offline" },
    { success: true, url: "https://cdn.example/ok.png" },
  ]);
});
