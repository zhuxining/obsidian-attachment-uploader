export const uploadCommandDict = {
  uPic: "/Applications/uPic.app/Contents/MacOS/uPic -o url -u %s",
  Picsee: "/Applications/Picsee.app/Contents/MacOS/Picsee -u %s",
  custom: "",
} as const;

export type UploadServiceName = keyof typeof uploadCommandDict;
