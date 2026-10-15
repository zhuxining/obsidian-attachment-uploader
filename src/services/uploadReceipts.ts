import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Notice } from "obsidian";

import { t } from "../lang/helpers";

export const UPLOAD_RECEIPT_KEYS = {
  saved: "Upload succeeded but was not applied. Recovery receipt:",
  failed: "Upload succeeded but recovery receipt could not be saved. URL:",
} as const;

/** Keep the cloud result recoverable even if the original editor no longer exists. */
export async function preserveUploadReceipt(
  url: string,
  sourcePath: string,
  filename: string,
): Promise<void> {
  let receiptPath: string;
  try {
    const root = join(homedir(), ".obsidian-attachment-uploader-recovery");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const directory = await mkdtemp(join(root, "upload-"));
    await chmod(directory, 0o700);
    receiptPath = join(directory, "receipt.json");
    await writeFile(
      receiptPath,
      JSON.stringify(
        { URL: url, sourcePath, filename, timestamp: new Date().toISOString() },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    await chmod(receiptPath, 0o600);
  } catch (error) {
    new Notice(`${t(UPLOAD_RECEIPT_KEYS.failed)} ${url}\n${String(error)}`, 0);
    return;
  }
  new Notice(`${t(UPLOAD_RECEIPT_KEYS.saved)} ${receiptPath}\n${url}`, 0);
}
