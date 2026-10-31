// 命令式提示（Zotero.alert、异常说明）的双语文案出口。
// DOM 文案走 FTL（addon/locale/*/dialogs.ftl），不要在这里重复定义。

declare const Zotero: any;

/** 宿主语言是否中文；宿主未就绪时按中文处理。 */
export function isChineseLocale(): boolean {
  return String(Zotero?.locale || "zh-CN").toLowerCase().startsWith("zh");
}

/** 同一句提示的中英两版，按宿主语言二选一。 */
export function localized(zh: string, en: string): string {
  return isChineseLocale() ? zh : en;
}
