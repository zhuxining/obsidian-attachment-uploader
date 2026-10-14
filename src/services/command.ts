import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

/** Split executable and arguments without expanding shell syntax. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next && (/\s/.test(next) || next === "\\" || next === "'" || next === '"')) {
        word += next;
        index += 1;
        started = true;
      } else { word += char; started = true; }
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote === null) quote = char;
      else word += char;
      started = true;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (started) words.push(word);
      word = ""; started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (quote !== null) throw new Error("Unclosed quote in upload command");
  if (started) words.push(word);
  return words;
}

export function prepareUploadCommand(command: string, filePath: string): { executable: string; args: string[] } {
  const [executable, ...argumentsTemplate] = splitCommand(command);
  if (!executable) throw new Error("Upload command is empty");
  if (executable.includes("%s")) throw new Error("Executable must not contain %s");
  if (argumentsTemplate.filter((value) => value === "%s").length !== 1 ||
    argumentsTemplate.some((value) => value !== "%s" && value.includes("%s"))) {
    throw new Error("Upload command must contain exactly one standalone %s argument");
  }
  if (!filePath || filePath.includes("\0")) throw new Error("Invalid attachment path");
  return { executable, args: argumentsTemplate.map((arg) => arg === "%s" ? filePath : arg) };
}

export async function executeUploadCommand(command: string, path: string): Promise<string> {
  const { executable, args } = prepareUploadCommand(command, path);
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: UPLOAD_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    shell: false,
    windowsHide: true,
  });
  return stdout;
}
