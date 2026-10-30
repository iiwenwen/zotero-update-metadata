// 对话框文案出口：FTL 是唯一来源（addon/locale/*/dialogs.ftl）。
// 静态文案在开窗时批量解析；带参数或随状态变化的文案在挂载后异步填入。
// 只读取主窗口的 document.l10n：about:blank 对话框不保证有 l10n，不能依赖。

declare const Zotero: any;

/** 构建后 FTL 文件名带插件前缀（见 zotero-plugin.config.ts 的 namespace）。 */
export const DIALOG_FTL = "zmta-dialogs.ftl";

export type MessageId = string;

export interface DialogCopy {
  /** 开窗时已解析的静态文案；缺键返回 id 本身并记日志，不阻断开窗。 */
  text(id: MessageId): string;
  /** 带参数或运行中变化的文案；写入 textContent，过期结果自动丢弃。 */
  apply(el: any, id: MessageId, args?: Record<string, unknown>): void;
  /** 同上，但写入指定属性（aria-label 之类不能放进 textContent 的位置）。 */
  attribute(el: any, name: string, id: MessageId, args?: Record<string, unknown>): void;
}

export interface CopyEntry {
  readonly elementID: string;
  readonly id: MessageId;
  readonly args?: Record<string, unknown>;
  /** 省略时写 textContent；给出时写该属性。 */
  readonly attribute?: string;
}

/** apply 与 attribute 共用的“最后写入者胜出”守卫。 */
function guardedWrite(pending: WeakMap<object, number>, el: any, write: (value: string) => void): (value: string) => void {
  const token = (pending.get(el) ?? 0) + 1;
  pending.set(el, token);
  return (value: string) => {
    if (pending.get(el) !== token) return;
    write(value);
  };
}

function documentL10n(win: any): any {
  try {
    return win?.document?.l10n ?? null;
  } catch {
    return null;
  }
}

/** 测试与离线布局使用：直接给出已解析的文案表。 */
export function staticDialogCopy(values: Readonly<Record<string, string>>): DialogCopy {
  const pending = new WeakMap<object, number>();
  return {
    text(id) {
      const value = values[id];
      if (value === undefined) {
        Zotero?.debug?.(`[zmta-i18n] 缺少文案：${id}`);
        return id;
      }
      return value;
    },
    apply(el, id, args) {
      if (!el) return;
      const write = guardedWrite(pending, el, (value) => { el.textContent = value; });
      const template = values[id];
      if (template === undefined) {
        Zotero?.debug?.(`[zmta-i18n] 缺少文案：${id}`);
        write(id);
        return;
      }
      write(fillArgs(template, args));
    },
    attribute(el, name, id, args) {
      if (!el) return;
      const write = guardedWrite(pending, el, (value) => { el.setAttribute?.(name, value); });
      const template = values[id];
      if (template === undefined) {
        Zotero?.debug?.(`[zmta-i18n] 缺少文案：${id}`);
        write(id);
        return;
      }
      write(fillArgs(template, args));
    },
  };
}

/** 离线替身只做 {$name} 直接替换；真实宿主由 Fluent 处理复数与格式化。 */
function fillArgs(template: string, args?: Record<string, unknown>): string {
  if (!args) return template;
  return template.replace(/\{\s*\$(\w+)\s*\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(args, name) ? String(args[name]) : whole);
}

export async function createDialogCopy(win: any, staticIds: readonly MessageId[]): Promise<DialogCopy> {
  const values = new Map<string, string>();
  const l10n = documentL10n(win);
  const ids = [...new Set(staticIds)];
  if (l10n?.formatValues && ids.length) {
    try {
      const resolved = await l10n.formatValues(ids.map((id) => ({ id })));
      ids.forEach((id, index) => {
        const value = resolved?.[index];
        if (typeof value === "string" && value) values.set(id, value);
      });
    } catch (error) {
      Zotero.debug(`[zmta-i18n] 对话框文案解析失败：${error}`);
    }
  }
  const pending = new WeakMap<object, number>();
  const format = (id: MessageId, args?: Record<string, unknown>): string => {
    const value = values.get(id);
    if (value === undefined) {
      Zotero.debug(`[zmta-i18n] 缺少文案：${id}`);
      return id;
    }
    return fillArgs(value, args);
  };
  return {
    text(id) {
      return format(id);
    },
    apply(el, id, args) {
      if (!el) return;
      const write = guardedWrite(pending, el, (value) => { el.textContent = value; });
      const target = documentL10n(el.ownerDocument?.defaultView) ?? l10n;
      if (!args || !target?.formatValue) {
        write(format(id, args));
        return;
      }
      Promise.resolve(target.formatValue(id, args))
        .then((value: unknown) => write(typeof value === "string" && value ? value : format(id)))
        .catch(() => write(format(id)));
    },
    attribute(el, name, id, args) {
      if (!el) return;
      const write = guardedWrite(pending, el, (value) => { el.setAttribute?.(name, value); });
      const target = documentL10n(el.ownerDocument?.defaultView) ?? l10n;
      if (!args || !target?.formatValue) {
        write(format(id, args));
        return;
      }
      Promise.resolve(target.formatValue(id, args))
        .then((value: unknown) => write(typeof value === "string" && value ? value : format(id)))
        .catch(() => write(format(id)));
    },
  };
}

/** 挂载后按 id 填充带参数文案；节点不存在时静默跳过。 */
export function fillCopy(doc: any, copy: DialogCopy, entries: readonly CopyEntry[]): void {
  for (const entry of entries) {
    const element = doc?.getElementById?.(entry.elementID);
    if (!element) continue;
    if (entry.attribute) copy.attribute(element, entry.attribute, entry.id, entry.args);
    else copy.apply(element, entry.id, entry.args);
  }
}
