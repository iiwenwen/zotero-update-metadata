// 对话框文案出口：FTL 是唯一来源（addon/locale/*/dialogs.ftl）。
// 静态文案在开窗时批量解析；带参数或随状态变化的文案在挂载后异步填入。
// 只读取主窗口的 document.l10n：about:blank 对话框不保证有 l10n，不能依赖。

declare const Zotero: any;

/** 构建后 FTL 文件名带插件前缀（见 zotero-plugin.config.ts 的 namespace）。 */
export const DIALOG_FTL = "zmta-dialogs.ftl";

/** 构建同时给 FTL 消息 id 加同一个前缀；代码里只写短 id，由这里统一补齐。 */
export const MESSAGE_NAMESPACE = "zmta";

/** 短 id → 运行时消息 id。已带前缀的原样返回，重复调用无副作用。 */
export function ftlMessageId(id: MessageId): MessageId {
  // 必须与构建的 needsPrefix 同一条规则（不带连字符），否则 zmtax-* 这类 id 会两边分叉。
  return id.startsWith(MESSAGE_NAMESPACE) ? id : `${MESSAGE_NAMESPACE}-${id}`;
}

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

/**
 * 取一条动态文案；缺失时返回 null 由调用方继续找下一个来源。
 * Fluent 对找不到的消息不报错，而是原样返回 id——必须按未解析处理，否则界面会显示 zmta-dlg-*。
 */
async function formatFrom(target: any, id: MessageId, args?: Record<string, unknown>): Promise<string | null> {
  if (!target?.formatValue) return null;
  try {
    const value = await Promise.resolve(target.formatValue(ftlMessageId(id), args));
    return typeof value === "string" && value && value !== ftlMessageId(id) ? value : null;
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
      const resolved = await l10n.formatValues(ids.map((id) => ({ id: ftlMessageId(id) })));
      ids.forEach((id, index) => {
        const value = resolved?.[index];
        // 缺失消息会被原样返回 id，不能当作已解析。
        if (typeof value === "string" && value && value !== ftlMessageId(id)) values.set(id, value);
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
  // 元素所在窗口的 l10n 未必注册了本插件 FTL：取不到就回主窗口，都取不到才退回静态表（保留参数）。
  const resolveInto = (write: (value: string) => void, el: any, id: MessageId, args?: Record<string, unknown>): void => {
    const target = documentL10n(el.ownerDocument?.defaultView);
    const fallback = () => write(format(id, args));
    if (!args || (!target?.formatValue && !l10n?.formatValue)) { fallback(); return; }
    formatFrom(target, id, args)
      .then(async (value) => value ?? (target === l10n ? null : await formatFrom(l10n, id, args)))
      .then((value) => write(value ?? format(id, args)))
      .catch(fallback);
  };
  return {
    text(id) {
      return format(id);
    },
    apply(el, id, args) {
      if (!el) return;
      resolveInto(guardedWrite(pending, el, (value) => { el.textContent = value; }), el, id, args);
    },
    attribute(el, name, id, args) {
      if (!el) return;
      resolveInto(guardedWrite(pending, el, (value) => { el.setAttribute?.(name, value); }), el, id, args);
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
