import { createHash } from "node:crypto";

import { uploadCommandDict, type UploadServiceName } from "./services/presets";

export type RemoteImagePastePolicy = "off" | "ask" | "auto";

export type RemoteImageAutoSource = "uPic" | "sample";

export interface RemoteImageAutoRule {
  prefixes: string[];
  source: RemoteImageAutoSource;
  detectedAt: string;
  fingerprint: string;
}

export interface PluginSettings {
  uploadService: UploadServiceName;
  uploadCommand: string;
  testFilePath: string;
  uploadFileFormat: Set<string>;
  isDeleteSourceFile: boolean;
  autoUploadOnSave: boolean;
  remoteImagePastePolicy: RemoteImagePastePolicy;
  remoteImageAutoDetectHost: boolean;
  remoteImageHostRules: Record<string, string[]>;
  remoteImageAutoHostRules: Record<string, RemoteImageAutoRule>;
}

const DEFAULT_FORMATS = ".png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.bmp";
const PASTE_POLICIES: readonly RemoteImagePastePolicy[] = ["off", "ask", "auto"];
const AUTO_SOURCES: readonly RemoteImageAutoSource[] = ["uPic", "sample"];
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_RULE_KEY_LENGTH = 200;
const MAX_PREFIXES_PER_RULE = 50;
const SCOPED_RULE_DIGEST_LENGTH = 16;

export function isUploadServiceName(value: unknown): value is UploadServiceName {
  return typeof value === "string" && Object.hasOwn(uploadCommandDict, value);
}

export function isRemoteImagePastePolicy(value: unknown): value is RemoteImagePastePolicy {
  return typeof value === "string" && PASTE_POLICIES.includes(value as RemoteImagePastePolicy);
}

/**
 * Rules are isolated by upload service and command digest so switching the
 * command never silently reuses prefixes learned for a different destination.
 */
export function remoteImageRuleScopeKey(service: string, command: string): string {
  const digest = createHash("sha256")
    .update(`${service}\u0000${command}`, "utf8")
    .digest("hex")
    .slice(0, SCOPED_RULE_DIGEST_LENGTH);
  return `${service}:${digest}`;
}

export function parseUploadFormats(value: string): Set<string> {
  return new Set(
    value
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((format) => {
        const normalized = format.toLowerCase();
        return normalized.startsWith(".") ? normalized : `.${normalized}`;
      }),
  );
}

function parsePrefixList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const prefixes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const prefix = item.trim();
    if (!prefix || prefix.length > 2048 || seen.has(prefix)) continue;
    seen.add(prefix);
    prefixes.push(prefix);
    if (prefixes.length >= MAX_PREFIXES_PER_RULE) break;
  }
  return prefixes;
}

function setOwnProperty<T>(target: Record<string, T>, key: string, value: T): void {
  if (!key || key.length > MAX_RULE_KEY_LENGTH || UNSAFE_KEYS.has(key)) return;
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function parseHostRules(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, prefixes] of Object.entries(value)) {
    const parsed = parsePrefixList(prefixes);
    if (parsed.length) setOwnProperty(result, key, parsed);
  }
  return result;
}

function parseAutoHostRules(value: unknown): Record<string, RemoteImageAutoRule> {
  const result: Record<string, RemoteImageAutoRule> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, rawRule] of Object.entries(value)) {
    if (rawRule === null || typeof rawRule !== "object" || Array.isArray(rawRule)) continue;
    const rule = rawRule as Record<string, unknown>;
    const prefixes = parsePrefixList(rule.prefixes);
    if (!prefixes.length) continue;
    if (
      typeof rule.source !== "string" ||
      !AUTO_SOURCES.includes(rule.source as RemoteImageAutoSource)
    )
      continue;
    if (typeof rule.fingerprint !== "string" || !rule.fingerprint) continue;
    const detectedAt = typeof rule.detectedAt === "string" ? rule.detectedAt : "";
    setOwnProperty(result, key, {
      prefixes,
      source: rule.source as RemoteImageAutoSource,
      detectedAt,
      fingerprint: rule.fingerprint,
    });
  }
  return result;
}

/** Persisted plugin data is untrusted; only accept fields with the expected type. */
export function parseSettings(value: unknown): PluginSettings {
  const data: Record<string, unknown> =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const uploadService = isUploadServiceName(data.uploadService) ? data.uploadService : "uPic";
  return {
    uploadService,
    uploadCommand:
      typeof data.uploadCommand === "string"
        ? data.uploadCommand
        : uploadCommandDict[uploadService],
    testFilePath: typeof data.testFilePath === "string" ? data.testFilePath : "",
    uploadFileFormat: parseUploadFormats(
      typeof data.uploadFileFormat === "string" ? data.uploadFileFormat : DEFAULT_FORMATS,
    ),
    isDeleteSourceFile:
      typeof data.isDeleteSourceFile === "boolean" ? data.isDeleteSourceFile : false,
    autoUploadOnSave: typeof data.autoUploadOnSave === "boolean" ? data.autoUploadOnSave : false,
    remoteImagePastePolicy: isRemoteImagePastePolicy(data.remoteImagePastePolicy)
      ? data.remoteImagePastePolicy
      : "off",
    remoteImageAutoDetectHost:
      typeof data.remoteImageAutoDetectHost === "boolean" ? data.remoteImageAutoDetectHost : true,
    remoteImageHostRules: parseHostRules(data.remoteImageHostRules),
    remoteImageAutoHostRules: parseAutoHostRules(data.remoteImageAutoHostRules),
  };
}

export function serializeSettings(settings: PluginSettings) {
  return { ...settings, uploadFileFormat: Array.from(settings.uploadFileFormat).join(",") };
}
