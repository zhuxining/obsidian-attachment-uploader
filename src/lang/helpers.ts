import { moment } from "obsidian";

import en from "./locale/en";
import zhCN from "./locale/zh-cn";

type TranslationKey = keyof typeof en;
const localeMap: Partial<Record<string, Record<TranslationKey, string>>> = {
  en,
  "zh-cn": zhCN satisfies Record<TranslationKey, string>,
};
const locale = localeMap[moment.locale()];

export function t(str: TranslationKey): string {
  return locale?.[str] ?? en[str];
}
