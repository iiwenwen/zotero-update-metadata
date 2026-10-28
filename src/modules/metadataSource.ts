// 当前批量候选链共用的条目字段与 Web Translator 兼容 helper。
// 本模块只读，不决定来源路由、审核或写入。

import { createWebTranslatorAdapter } from "./providers/webTranslator";

declare const Zotero: any;

const LOG_PREFIX = "[zmta-update]";

export interface MetadataFieldDiff {
  field: string;
  local: unknown;
  incoming: unknown;
  isConflict: boolean;
}

export function getItemURL(item: any): string | null {
  try {
    const url = item.getField("url");
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/** 兼容旧 Provider 注入点：失败返回 null，由调用层沿用既定分类。 */
export async function fetchFromTranslator(url: string): Promise<any> {
  try {
    return await createWebTranslatorAdapter().translate(url);
  } catch (error) {
    Zotero.debug(`${LOG_PREFIX} Translator 获取失败： ${error}`);
    return null;
  }
}

export function diffFields(item: any, incoming: any): MetadataFieldDiff[] {
  const safeFields = [
    "title", "shortTitle", "publisher", "date", "ISBN", "numPages",
    "abstractNote", "url", "language", "series", "edition", "place", "extra",
  ];
  const diffs: MetadataFieldDiff[] = [];
  for (const field of safeFields) {
    const local = item.getField(field);
    const candidate = incoming[field];
    if (candidate !== undefined && candidate !== null && String(candidate) !== String(local ?? "")) {
      diffs.push({ field, local, incoming: candidate, isConflict: true });
    }
  }
  return diffs;
}
