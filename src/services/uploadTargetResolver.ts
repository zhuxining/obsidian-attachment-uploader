import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { splitCommand } from "./command";
import type { UploadServiceName } from "./presets";

const execFileAsync = promisify(execFile);

const PLUTIL_EXECUTABLE = "/usr/bin/plutil";
const READ_TIMEOUT_MS = 5_000;
const MAX_PLIST_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MIN_UPIC_MAJOR = 1;
const MIN_UPIC_MINOR = 4;
const FINGERPRINT_LENGTH = 16;

const DEFAULT_HOST_ID_KEY = "uPic_DefaultHostId";
const HOST_ITEMS_KEY = "uPic_hostItems";
const HOST_INFO_PLIST = "Contents/Info.plist";

/** Shared hosts need enough of the path to identify one account/repository. */
const SHARED_HOST_MIN_DEPTH: Readonly<Record<string, number>> = {
  "raw.githubusercontent.com": 2,
  "gitee.com": 2,
  "github.com": 2,
  "gitlab.com": 2,
  "cdn.jsdelivr.net": 2,
};

const HOST_TYPE_BY_INT: Readonly<Record<number, string>> = {
  [-1]: "custom",
  1: "smms",
  2: "qiniu_kodo",
  3: "upyun_uss",
  4: "aliyun_oss",
  5: "tencent_cos",
  6: "github",
  7: "gitee",
  8: "weibo",
  9: "s3",
  10: "imgur",
  11: "baidu_bos",
};

const HOST_TYPES_WITH_DOMAIN = new Set([
  "qiniu_kodo",
  "upyun_uss",
  "aliyun_oss",
  "tencent_cos",
  "github",
  "gitee",
  "s3",
  "baidu_bos",
]);

export type UploadTargetReason =
  | "not-macos"
  | "not-upic"
  | "app-missing"
  | "unsupported-version"
  | "preferences-unavailable"
  | "no-default-host"
  | "no-public-domain"
  | "invalid-structure"
  | "shared-host-too-broad";

export interface UploadTargetDetection {
  status: "detected" | "unavailable" | "unsupported";
  prefixes: string[];
  source: "uPic";
  fingerprint: string | null;
  appVersion: string | null;
  reason: UploadTargetReason | null;
}

export interface ResolverIo {
  platform: string;
  homeDir(): string;
  statSize(path: string): Promise<number | null>;
  exec(executable: string, args: string[]): Promise<string | null>;
  realpath?(path: string): Promise<string | null>;
}

export interface RemoteHostPrefix {
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
  pathname: string;
  text: string;
}

export type DomainPrefixResult = { prefix: string } | { reason: UploadTargetReason };

const defaultIo: ResolverIo = {
  platform: process.platform,
  homeDir: homedir,
  async statSize(path: string): Promise<number | null> {
    try {
      const value = await stat(path);
      return value.isFile() ? value.size : null;
    } catch {
      return null;
    }
  },
  async exec(executable: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(executable, args, {
        encoding: "utf8",
        timeout: READ_TIMEOUT_MS,
        maxBuffer: MAX_TOOL_OUTPUT_BYTES,
        shell: false,
        windowsHide: true,
      });
      return stdout;
    } catch {
      return null;
    }
  },
  async realpath(path: string): Promise<string | null> {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  },
};

function unavailable(reason: UploadTargetReason): UploadTargetDetection {
  return {
    status: "unavailable",
    prefixes: [],
    source: "uPic",
    fingerprint: null,
    appVersion: null,
    reason,
  };
}

function unsupported(reason: UploadTargetReason, appVersion: string | null): UploadTargetDetection {
  return {
    status: "unsupported",
    prefixes: [],
    source: "uPic",
    fingerprint: null,
    appVersion,
    reason,
  };
}

function readPlutilString(io: ResolverIo, path: string, key: string): Promise<string | null> {
  return io
    .exec(PLUTIL_EXECUTABLE, ["-extract", key, "raw", "-o", "-", path])
    .then((value) => value?.trim() ?? null);
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function isSupportedUpicVersion(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major === MIN_UPIC_MAJOR && minor >= MIN_UPIC_MINOR;
}

function isUpicExecutable(executable: string): boolean {
  return (
    basename(executable).toLowerCase() === "upic" ||
    /(?:^|[/\\])upic\.app(?:[/\\]|$)/i.test(executable)
  );
}

function appBundleFromExecutable(executable: string): string | null {
  const index = executable.toLowerCase().indexOf(".app/");
  if (index < 0) return null;
  return executable.slice(0, index + ".app".length);
}

function countPathSegments(pathname: string): number {
  return pathname.split("/").filter(Boolean).length;
}

/**
 * `saveKeyPath` is a key template. Only the directory that is fixed before the
 * first template marker can be proven to belong to the current host.
 */
function fixedSaveKeyDirectory(saveKeyPath: string | undefined): string | null {
  if (!saveKeyPath) return "";
  let value = saveKeyPath.trim().replace(/^\/+/, "");
  if (!value) return "";

  const marker = value.search(/[{$]/);
  if (marker === 0) return "";
  if (marker > 0) {
    const slash = value.lastIndexOf("/", marker - 1);
    value = slash >= 0 ? value.slice(0, slash) : "";
  } else if (!value.endsWith("/")) {
    const slash = value.lastIndexOf("/");
    const lastSegment = value.slice(slash + 1);
    value = lastSegment.includes(".") ? value.slice(0, slash + 1) : value;
  }

  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function joinPrefixPath(domainPath: string, directory: string): string {
  const base = domainPath === "/" ? "" : `/${domainPath.split("/").filter(Boolean).join("/")}`;
  const suffix = directory ? `/${directory}` : "";
  const combined = `${base}${suffix}`;
  return combined ? `${combined}/` : "/";
}

export function buildUpicDomainPrefix(domain: string, saveKeyPath?: string): DomainPrefixResult {
  let parsed: URL;
  try {
    parsed = new URL(domain.trim());
  } catch {
    return { reason: "no-public-domain" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { reason: "no-public-domain" };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { reason: "no-public-domain" };
  }

  const directory = fixedSaveKeyDirectory(saveKeyPath);
  if (directory === null) return { reason: "invalid-structure" };
  const pathname = joinPrefixPath(parsed.pathname, directory);
  const prefix = `${parsed.protocol}//${parsed.host}${pathname}`;
  const minimumDepth = SHARED_HOST_MIN_DEPTH[parsed.hostname.toLowerCase()];
  if (minimumDepth !== undefined && countPathSegments(pathname) < minimumDepth) {
    return { reason: "shared-host-too-broad" };
  }
  return { prefix };
}

function hostTypeName(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isInteger(value)) return HOST_TYPE_BY_INT[value] ?? null;
  return null;
}

function fingerprintFor(
  appVersion: string,
  defaultHostId: string,
  type: string,
  prefixes: string[],
) {
  // No secrets are read; the digest only invalidates stale detections.
  return createHash("sha256")
    .update([appVersion, defaultHostId, type, ...prefixes].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

interface DetectionContext {
  io: ResolverIo;
  appVersion: string;
}

async function readUpicHosts(
  context: DetectionContext,
  preferencesPath: string,
): Promise<UploadTargetDetection | null> {
  const { io } = context;
  const defaultHostId = await readPlutilString(io, preferencesPath, DEFAULT_HOST_ID_KEY);
  if (!defaultHostId) return null;
  const hostItemsRaw = await io.exec(PLUTIL_EXECUTABLE, [
    "-extract",
    HOST_ITEMS_KEY,
    "json",
    "-o",
    "-",
    preferencesPath,
  ]);
  if (!hostItemsRaw) return unsupported("invalid-structure", context.appVersion);

  let hostItems: unknown;
  try {
    hostItems = JSON.parse(hostItemsRaw);
  } catch {
    return unsupported("invalid-structure", context.appVersion);
  }
  if (!Array.isArray(hostItems)) return unsupported("invalid-structure", context.appVersion);

  let defaultHost: Record<string, unknown> | null = null;
  for (const item of hostItems) {
    if (typeof item !== "string") continue;
    let host: unknown;
    try {
      host = JSON.parse(item);
    } catch {
      continue;
    }
    if (host === null || typeof host !== "object" || Array.isArray(host)) continue;
    const candidate = host as Record<string, unknown>;
    if (candidate.id === defaultHostId) {
      defaultHost = candidate;
      break;
    }
  }
  if (!defaultHost) {
    return unsupported("no-default-host", context.appVersion);
  }

  const type = hostTypeName(defaultHost.type);
  if (!type || !HOST_TYPES_WITH_DOMAIN.has(type)) {
    return unsupported("no-public-domain", context.appVersion);
  }

  let data: unknown = defaultHost.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return unsupported("invalid-structure", context.appVersion);
    }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return unsupported("invalid-structure", context.appVersion);
  }
  const config = data as Record<string, unknown>;
  const domain = typeof config.domain === "string" ? config.domain.trim() : "";
  if (!domain) return unsupported("no-public-domain", context.appVersion);
  const saveKeyPath = typeof config.saveKeyPath === "string" ? config.saveKeyPath : undefined;

  const built = buildUpicDomainPrefix(domain, saveKeyPath);
  if ("reason" in built) return unsupported(built.reason, context.appVersion);

  return {
    status: "detected",
    prefixes: [built.prefix],
    source: "uPic",
    fingerprint: fingerprintFor(context.appVersion, defaultHostId, type, [built.prefix]),
    appVersion: context.appVersion,
    reason: null,
  };
}

export interface ResolveUploadTargetOptions {
  service: UploadServiceName;
  command: string;
  io?: ResolverIo;
}

/**
 * Read-only uPic detection. Only the current default host's public domain and
 * the fixed part of its save path are projected; the raw configuration never
 * leaves this module.
 */
export async function resolveUploadTarget(
  options: ResolveUploadTargetOptions,
): Promise<UploadTargetDetection> {
  const io = options.io ?? defaultIo;
  if (io.platform !== "darwin") return unavailable("not-macos");
  if (options.service !== "uPic") return unavailable("not-upic");

  let executable: string;
  try {
    [executable] = splitCommand(options.command);
  } catch {
    return unavailable("not-upic");
  }
  if (!executable || !isUpicExecutable(executable)) return unavailable("not-upic");

  let resolvedExecutable = executable;
  if (!appBundleFromExecutable(resolvedExecutable) && io.realpath) {
    resolvedExecutable = (await io.realpath(executable)) ?? resolvedExecutable;
  }
  const bundleRoot = appBundleFromExecutable(resolvedExecutable);
  if (!bundleRoot) return unavailable("app-missing");
  const infoPlist = join(bundleRoot, HOST_INFO_PLIST);
  if ((await io.statSize(infoPlist)) === null) return unavailable("app-missing");

  const bundleId = await readPlutilString(io, infoPlist, "CFBundleIdentifier");
  const appVersion = await readPlutilString(io, infoPlist, "CFBundleShortVersionString");
  if (!bundleId || !/^[\w.-]+$/.test(bundleId) || !appVersion) {
    return unavailable("app-missing");
  }
  if (!isSupportedUpicVersion(appVersion)) {
    return unsupported("unsupported-version", appVersion);
  }

  const context: DetectionContext = { io, appVersion };
  const home = io.homeDir();
  const candidates = [
    join(home, "Library", "Preferences", `${bundleId}.plist`),
    join(
      home,
      "Library",
      "Containers",
      bundleId,
      "Data",
      "Library",
      "Preferences",
      `${bundleId}.plist`,
    ),
  ];

  let sawPreferences = false;
  for (const candidate of candidates) {
    const size = await io.statSize(candidate);
    if (size === null || size <= 0 || size > MAX_PLIST_BYTES) continue;
    sawPreferences = true;
    const result = await readUpicHosts(context, candidate);
    if (result) return result;
  }
  return unavailable(sawPreferences ? "invalid-structure" : "preferences-unavailable");
}

export function parseRemoteHostPrefix(value: string): RemoteHostPrefix | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;

  const pathname = joinPrefixPath(parsed.pathname, "");
  const minimumDepth = SHARED_HOST_MIN_DEPTH[parsed.hostname.toLowerCase()];
  if (minimumDepth !== undefined && countPathSegments(pathname) < minimumDepth) return null;

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port,
    pathname,
    text: `${parsed.protocol}//${parsed.host}${pathname}`,
  };
}

export function normalizeRemoteHostPrefix(value: string): string | null {
  return parseRemoteHostPrefix(value)?.text ?? null;
}

export function compileRemoteHostPrefixes(values: readonly string[]): RemoteHostPrefix[] {
  const seen = new Set<string>();
  const prefixes: RemoteHostPrefix[] = [];
  for (const value of values) {
    const parsed = parseRemoteHostPrefix(value);
    if (!parsed || seen.has(parsed.text)) continue;
    seen.add(parsed.text);
    prefixes.push(parsed);
  }
  return prefixes;
}

/**
 * Protocol, exact host, effective port and a path-directory boundary must all
 * match. Query strings and fragments in the image URL are preserved separately
 * and never relaxed here.
 */
export function isUrlCoveredByPrefix(url: URL, prefix: RemoteHostPrefix): boolean {
  if (url.protocol !== prefix.protocol) return false;
  if (url.hostname.toLowerCase() !== prefix.hostname) return false;
  if (url.port !== prefix.port) return false;
  return prefix.pathname === "/" || url.pathname.startsWith(prefix.pathname);
}

export function isOwnRemoteImageUrl(url: string, prefixes: readonly RemoteHostPrefix[]): boolean {
  if (!prefixes.length) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return prefixes.some((prefix) => isUrlCoveredByPrefix(parsed, prefix));
}

/**
 * A single successful upload URL can only be offered as a reviewable
 * suggestion. Shared hosts need a directory specific enough to identify an
 * account or repository; otherwise no safe suggestion is produced.
 */
export function suggestPrefixFromSampleUrl(sample: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(sample.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  const directory = parsed.pathname.endsWith("/")
    ? segments
    : segments.slice(0, Math.max(0, segments.length - 1));
  const minimumDepth = SHARED_HOST_MIN_DEPTH[parsed.hostname.toLowerCase()];
  if (minimumDepth !== undefined && directory.length < minimumDepth) return null;

  const pathname = directory.length ? `/${directory.join("/")}/` : "/";
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}
