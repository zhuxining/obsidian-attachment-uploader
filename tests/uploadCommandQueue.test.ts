import { expect, test } from "vite-plus/test";

import { UploadCommandQueue } from "../src/services/uploadCommandQueue";

test("serializes different note uploads without sharing their results", async () => {
  const queue = new UploadCommandQueue();
  let running = 0;
  let peak = 0;
  const jobs = ["A", "B", "C"].map((note) =>
    queue.enqueue(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return note;
    }),
  );
  expect(await Promise.all(jobs)).toEqual(["A", "B", "C"]);
  expect(peak).toBe(1);
});

test("a cancelled waiter settles immediately without executing or blocking subsequent jobs", async () => {
  const queue = new UploadCommandQueue();
  let finish!: () => void;
  const first = queue.enqueue(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  let executed = false;
  const waiter = queue.enqueue(async () => {
    executed = true;
  }, controller.signal);
  controller.abort();
  await expect(waiter).rejects.toThrow("cancelled");
  expect(executed).toBe(false);
  const last = queue.enqueue(async () => "last");
  finish();
  await first;
  expect(await last).toBe("last");
});

test("cancelling a running command waits for its result and failure releases the queue", async () => {
  const queue = new UploadCommandQueue();
  const controller = new AbortController();
  let finish!: (value: string) => void;
  const first = queue.enqueue(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    controller.signal,
  );
  controller.abort();
  finish("recoverable URL");
  expect(await first).toBe("recoverable URL");
  await expect(
    queue.enqueue(async () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  expect(await queue.enqueue(async () => "next")).toBe("next");
});
