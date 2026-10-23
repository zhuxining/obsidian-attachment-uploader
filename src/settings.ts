export const uploadCommandDict = {
  uPic: "/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s",
  Picsee: "/Applications/Picsee.app/Contents/MacOS/Picsee -u %s",
  custom: "",
} as const;

export type UploadServiceName = keyof typeof uploadCommandDict;

export interface PluginSettings {
  uploadService: UploadServiceName;
  uploadCommand: string;
  uploadFileFormat: Set<string>;
  isDeleteSourceFile: boolean;
  autoUpload: boolean;
  autoTransferRemoteImages: boolean;
  remoteImageSkipPrefixes: string[];
}

const DEFAULT_FORMATS = ".png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.bmp";
export function isUploadServiceName(value: unknown): value is UploadServiceName {
  return typeof value === "string" && Object.hasOwn(uploadCommandDict, value);
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
    uploadFileFormat: parseUploadFormats(
      typeof data.uploadFileFormat === "string" ? data.uploadFileFormat : DEFAULT_FORMATS,
    ),
    isDeleteSourceFile:
      typeof data.isDeleteSourceFile === "boolean" ? data.isDeleteSourceFile : false,
    autoUpload: typeof data.autoUpload === "boolean" ? data.autoUpload : true,
    autoTransferRemoteImages: data.autoTransferRemoteImages === true,
    remoteImageSkipPrefixes: Array.isArray(data.remoteImageSkipPrefixes)
      ? data.remoteImageSkipPrefixes
          .filter((prefix): prefix is string => typeof prefix === "string")
          .map((prefix) => prefix.trim())
          .filter(Boolean)
      : [],
  };
}

export function serializeSettings(settings: PluginSettings) {
  return { ...settings, uploadFileFormat: Array.from(settings.uploadFileFormat).join(",") };
}
