declare const Zotero: any;

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** 仅做人工修改冲突标记；正文、路径与标注内容不写入 journal。缺少状态时保守保留。 */
export function createdItemFingerprint(item: any): string | undefined {
  try {
    if (!item?.key || typeof item.toJSON !== "function") return undefined;
    const note = item.isNote?.() === true;
    const attachment = item.isAttachment?.() === true;
    if (!note && !attachment) return undefined;
    // 服务器同步版本不属于人工内容；其余元数据与文件状态仍参与保护。
    const data = { ...item.toJSON() };
    delete data.version;
    const state: Record<string, unknown> = {
      key: item.key, libraryID: item.libraryID, parentID: item.parentID,
      data,
    };
    if (attachment) {
      if (typeof item.getAnnotations !== "function") return undefined;
      state.annotations = item.getAnnotations(true).map((entry: any) => entry.toJSON());
      const filePath = item.getFilePath?.();
      if (filePath) {
        const file = Zotero.File.pathToFile(filePath);
        state.file = { size: file.fileSize, modified: file.lastModifiedTime };
      }
    }
    const text = JSON.stringify(canonical(state));
    const digest = Zotero.Utilities.Internal.md5(text);
    return typeof digest === "string" && digest ? `child-v2:${text.length}:${digest}` : undefined;
  } catch {
    return undefined;
  }
}

export interface CreationNotifier {
  register(observer: { notify(event: string, type: string, ids: readonly number[], extraData: any): void }): string;
  unregister(id: string): void;
  getItem(id: number): any;
}

let creationSequence = 0;

/** 在本次保存的 add 通知中捕获，绝不在创建 Promise 返回后补造初始状态。 */
export function observeCreatedItem(
  parent: { id: number; libraryID: number },
  notifier: CreationNotifier | undefined,
  isInitial: (item: any) => boolean,
) {
  const token = `zmta-${Date.now()}-${++creationSequence}-${Math.random().toString(36).slice(2)}`;
  const parentID = parent.id;
  const libraryID = parent.libraryID;
  const seen = new Set<number>();
  const initial = new Map<number, { key: string; fingerprint: string }>();
  let observerID: string | undefined;
  let closed = false;
  try {
    observerID = notifier?.register({ notify(event, type, ids, extraData) {
      if (closed || event !== "add" || type !== "item") return;
      for (const id of ids) {
        if (extraData?.[id]?.zmtaCreationToken !== token || seen.has(id)) continue;
        seen.add(id);
        try {
          const item = notifier!.getItem(id);
          if (item?.parentID !== parentID || item?.libraryID !== libraryID || !isInitial(item)) continue;
          const fingerprint = createdItemFingerprint(item);
          if (fingerprint) initial.set(id, { key: item.key, fingerprint });
        } catch { /* 无法证明初始状态时保留，不阻断创建。 */ }
      }
    } });
  } catch { /* 缺少宿主能力时不得退回 await 后读取。 */ }
  return {
    saveOptions: observerID ? { notifierData: { zmtaCreationToken: token } } : undefined,
    fingerprint(item: any): string | undefined {
      const value = initial.get(item?.id);
      return value?.key === item?.key ? value?.fingerprint : undefined;
    },
    close(): void {
      closed = true;
      try { if (observerID) notifier?.unregister(observerID); }
      catch { /* 观察者已失活，不能让清理异常掩盖已创建的子项。 */ }
      initial.clear();
    },
  };
}
