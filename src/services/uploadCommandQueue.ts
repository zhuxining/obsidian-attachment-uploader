interface PendingUpload {
  run(): void;
}

/** One external process at a time. Cancelling a waiter never interrupts a running upload. */
export class UploadCommandQueue {
  private running = false;
  private readonly pending: PendingUpload[] = [];

  enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.pending.indexOf(job);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error("Upload cancelled before execution"));
      };
      const job: PendingUpload = {
        run: () => {
          signal?.removeEventListener("abort", abort);
          this.running = true;
          void (async () => {
            try {
              resolve(await task());
            } catch (error) {
              reject(error);
            } finally {
              this.running = false;
              this.next();
            }
          })();
        },
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(job);
      this.next();
    });
  }

  private next(): void {
    if (!this.running) this.pending.shift()?.run();
  }
}
