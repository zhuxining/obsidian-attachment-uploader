import { uploadCommandDict, type UploadServiceName } from "./services/presets";

export interface PluginSettings {
  uploadService: UploadServiceName;
  uploadCommand: string;
  testFilePath: string;
  uploadFileFormat: Set<string>;
  isDeleteSourceFile: boolean;
  autoUploadOnSave: boolean;
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
    testFilePath: typeof data.testFilePath === "string" ? data.testFilePath : "",
    uploadFileFormat: parseUploadFormats(
      typeof data.uploadFileFormat === "string" ? data.uploadFileFormat : DEFAULT_FORMATS,
    ),
    isDeleteSourceFile:
      typeof data.isDeleteSourceFile === "boolean" ? data.isDeleteSourceFile : false,
    autoUploadOnSave: typeof data.autoUploadOnSave === "boolean" ? data.autoUploadOnSave : false,
  };
}

export function serializeSettings(settings: PluginSettings) {
  return { ...settings, uploadFileFormat: Array.from(settings.uploadFileFormat).join(",") };
}
