import { localized } from "../../utils/locale";
import {
  ChangeExecutionError,
  type CandidateAttachment,
  type CandidateCreator,
  type MetadataItemRef,
  type ZoteroMutationPort,
} from "./contracts";
import { createdItemFingerprint, observeCreatedItem, type CreationNotifier } from "./createdItemState";

declare const Zotero: any;

export interface ZoteroMutationHost {
  readonly userLibraryID: number;
  getItem(itemID: number): Promise<any | null> | any | null;
  importAttachment(options: {
    url: string;
    contentType: string;
    title: string;
    parentItemID: number;
    libraryID: number;
    saveOptions?: { notifierData: Record<string, string> };
  }): Promise<any>;
  createItem(kind: "note"): any;
  trashItem(itemID: number): Promise<void>;
  readonly creationNotifier?: CreationNotifier;
}

function defaultHost(): ZoteroMutationHost {
  return {
    userLibraryID: Number(Zotero.Libraries.userLibraryID),
    getItem: (itemID) => Zotero.Items.getAsync(itemID),
    importAttachment: (options) => Zotero.Attachments.importFromURL(options),
    createItem: (kind) => new Zotero.Item(kind),
    trashItem: async (itemID) => Zotero.Items.trashTx(itemID),
    creationNotifier: {
      register: (observer) => Zotero.Notifier.registerObserver(observer, ["item"], "zmta-create", -1000),
      unregister: (id) => Zotero.Notifier.unregisterObserver(id),
      getItem: (id) => Zotero.Items.get(id),
    },
  };
}

function itemType(item: any): string | undefined {
  if (typeof item?.itemType === "string") return item.itemType;
  try {
    if (item?.itemTypeID !== undefined) return Zotero.ItemTypes.getName(item.itemTypeID);
  } catch {
    // 注入 fake host 时可能没有 Zotero 全局，其他身份字段仍必须匹配。
  }
  return undefined;
}

function assertItemIdentity(item: any, ref: MetadataItemRef): void {
  const actualType = itemType(item);
  if (
    Number(item.id) !== ref.itemID ||
    String(item.key || "") !== ref.itemKey ||
    (ref.libraryID !== 0 && Number(item.libraryID) !== ref.libraryID) ||
    (actualType !== undefined && actualType !== ref.itemType)
  ) {
    throw new ChangeExecutionError(
      "item-mismatch",
      localized(`条目身份已变化，未写入：${ref.itemKey}`, `The item identity changed. Nothing was saved: ${ref.itemKey}`),
    );
  }
}

function mutableCreators(creators: readonly CandidateCreator[]): CandidateCreator[] {
  return creators.map((creator) => ({ ...creator }));
}

/** Zotero 运行时写入的唯一适配面；测试可注入不落库的 fake host。 */
export class DefaultZoteroMutationPort implements ZoteroMutationPort<any, any> {
  private readonly creationFingerprints = new WeakMap<object, string | undefined>();
  constructor(private readonly host: ZoteroMutationHost = defaultHost()) {}

  private async trackCreation(parent: any, isInitial: (item: any) => boolean, create: (options: ReturnType<typeof observeCreatedItem>["saveOptions"]) => Promise<any>): Promise<any> {
    const observation = observeCreatedItem(parent, this.host.creationNotifier, isInitial);
    try {
      const created = await create(observation.saveOptions);
      this.creationFingerprints.set(created, observation.fingerprint(created));
      return created;
    } finally {
      observation.close();
    }
  }

  async getItem(ref: MetadataItemRef): Promise<any | null> {
    const item = await this.host.getItem(ref.itemID);
    if (!item) return null;
    assertItemIdentity(item, ref);
    return item;
  }

  getField(item: any, field: string): unknown {
    return item.getField(field);
  }

  setField(item: any, field: string, value: unknown): void {
    item.setField(field, value);
  }

  getCreators(item: any): readonly CandidateCreator[] {
    return item.getCreatorsJSON();
  }

  setCreators(item: any, creators: readonly CandidateCreator[]): void {
    item.setCreators(mutableCreators(creators), { strict: true });
  }

  async saveItem(item: any): Promise<void> {
    await item.saveTx();
  }

  async createAttachment(
    item: any,
    candidate: Omit<CandidateAttachment, "operationId">,
  ): Promise<any> {
    const url = candidate.url ? String(candidate.url) : "";
    const contentType = candidate.mimeType ? String(candidate.mimeType) : "";
    const title = candidate.title ? String(candidate.title) : "";
    if (!url || !contentType || !title) {
      throw new ChangeExecutionError(
        "write-failed",
        localized("附件缺少有效的网址、文件类型或标题", "The attachment is missing a valid URL, file type, or title."),
      );
    }
    return this.trackCreation(item, (child) => {
      const data = child.toJSON();
      return child.isAttachment?.() === true && child.getAnnotations(true).length === 0
        && !data.note && !(data.tags?.length) && Object.keys(data.relations || {}).length === 0
        && data.title === title && data.url === url && data.contentType === contentType;
    }, (saveOptions) => this.host.importAttachment({
      url,
      contentType,
      title,
      parentItemID: Number(item.id),
      libraryID: Number(item.libraryID || this.host.userLibraryID),
      ...(saveOptions ? { saveOptions } : {}),
    }));
  }

  async createNote(item: any, content: string): Promise<any> {
    const note = this.host.createItem("note");
    note.libraryID = item.libraryID;
    note.parentID = item.id;
    note.setNote(content);
    let expected: string | undefined;
    try { expected = typeof note.getNote === "function" ? note.getNote() : note.toJSON().note; } catch { /* 无证明则保留。 */ }
    return this.trackCreation(item, (child) => {
      const data = child.toJSON();
      const current = typeof child.getNote === "function" ? child.getNote() : data.note;
      return child.isNote?.() === true && expected !== undefined && current === expected
        && !(data.tags?.length) && Object.keys(data.relations || {}).length === 0;
    }, async (saveOptions) => {
      await note.saveTx(saveOptions);
      return note;
    });
  }

  async trashCreatedItem(item: any, expectedFingerprint?: string): Promise<void> {
    if (!item || item.id === undefined || item.id === null) {
      throw new ChangeExecutionError(
        "compensation-failed",
        localized("无法确认新增内容的编号，未移入回收站", "The new item could not be identified and was not moved to the trash."),
      );
    }
    if (!expectedFingerprint || this.getCreatedItemFingerprint(item) !== expectedFingerprint) {
      throw new ChangeExecutionError("conflict", localized("新增内容已被改动或无法确认初始状态，已保留", "The new content was kept because it changed or its initial state could not be verified."));
    }
    await this.host.trashItem(Number(item.id));
  }

  getCreatedItemKey(item: any): string | undefined {
    return typeof item?.key === "string" && item.key.length > 0 ? item.key : undefined;
  }

  getCreatedItemFingerprint(item: any): string | undefined {
    return createdItemFingerprint(item);
  }

  getCreatedItemCreationFingerprint(item: any): string | undefined {
    return this.creationFingerprints.get(item);
  }
}

/** 兼容旧测试注入点；未覆盖的方法仍走唯一默认宿主端口。 */
export class DelegatingZoteroMutationPort implements ZoteroMutationPort<any, any> {
  constructor(
    private readonly overrides: Partial<ZoteroMutationPort<any, any>> = {},
    private readonly fallback: ZoteroMutationPort<any, any> = new DefaultZoteroMutationPort(),
  ) {}

  async getItem(ref: MetadataItemRef): Promise<any | null> {
    const item = this.overrides.getItem
      ? await this.overrides.getItem(ref)
      : await this.fallback.getItem(ref);
    if (item) assertItemIdentity(item, ref);
    return item;
  }

  getField(item: any, field: string): unknown {
    return this.overrides.getField?.(item, field) ?? this.fallback.getField(item, field);
  }

  setField(item: any, field: string, value: unknown): void {
    if (this.overrides.setField) this.overrides.setField(item, field, value);
    else this.fallback.setField(item, field, value);
  }

  getCreators(item: any): readonly CandidateCreator[] {
    return this.overrides.getCreators?.(item) ?? this.fallback.getCreators(item);
  }

  setCreators(item: any, creators: readonly CandidateCreator[]): void {
    if (this.overrides.setCreators) this.overrides.setCreators(item, creators);
    else this.fallback.setCreators(item, creators);
  }

  async saveItem(item: any): Promise<void> {
    if (this.overrides.saveItem) await this.overrides.saveItem(item);
    else await this.fallback.saveItem(item);
  }

  async createAttachment(item: any, candidate: Omit<CandidateAttachment, "operationId">): Promise<any> {
    return this.overrides.createAttachment
      ? this.overrides.createAttachment(item, candidate)
      : this.fallback.createAttachment(item, candidate);
  }

  async createNote(item: any, content: string): Promise<any> {
    return this.overrides.createNote
      ? this.overrides.createNote(item, content)
      : this.fallback.createNote(item, content);
  }

  async trashCreatedItem(item: any, expectedFingerprint?: string): Promise<void> {
    if (this.overrides.trashCreatedItem) await this.overrides.trashCreatedItem(item, expectedFingerprint);
    else await this.fallback.trashCreatedItem(item, expectedFingerprint);
  }

  getCreatedItemKey(item: any): string | undefined {
    return this.overrides.getCreatedItemKey?.(item) ?? this.fallback.getCreatedItemKey(item);
  }

  getCreatedItemFingerprint(item: any): string | undefined {
    return this.overrides.getCreatedItemFingerprint
      ? this.overrides.getCreatedItemFingerprint(item)
      : this.fallback.getCreatedItemFingerprint?.(item);
  }

  getCreatedItemCreationFingerprint(item: any): string | undefined {
    if (this.overrides.getCreatedItemCreationFingerprint) return this.overrides.getCreatedItemCreationFingerprint(item);
    // 覆盖创建者必须显式提供创建证明，不能把当前状态推导为初始状态。
    if (this.overrides.createAttachment || this.overrides.createNote) return undefined;
    return this.fallback.getCreatedItemCreationFingerprint?.(item);
  }
}

/** journal 回滚使用的宿主端口；回滚仍只消费 journal，不接触 Provider。 */
export class DefaultZoteroRollbackPort {
  getCreatedItemFingerprint(item: any): string | undefined {
    return createdItemFingerprint(item);
  }
  async getItem(libraryID: number, itemKey: string): Promise<any | null> {
    return Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
  }

  getField(item: any, field: string): unknown {
    return item.getField(field);
  }

  setField(item: any, field: string, value: unknown): void {
    item.setField(field, value);
  }

  getCreators(item: any): readonly CandidateCreator[] {
    return item.getCreatorsJSON();
  }

  setCreators(item: any, creators: readonly CandidateCreator[]): void {
    item.setCreators(mutableCreators(creators), { strict: true });
  }

  async saveItem(item: any): Promise<void> {
    await item.saveTx();
  }

  async trashItem(libraryID: number, itemKey: string, expectedFingerprint?: string): Promise<void> {
    const item = await this.getItem(libraryID, itemKey);
    if (!item) throw new ChangeExecutionError("item-not-found", localized(`找不到新增内容：${itemKey}`, `The new content could not be found: ${itemKey}`));
    if (!expectedFingerprint || this.getCreatedItemFingerprint(item) !== expectedFingerprint) {
      throw new ChangeExecutionError("conflict", localized("新增内容已被改动或无法确认初始状态，已保留", "The new content was kept because it changed or its initial state could not be verified."));
    }
    await Zotero.Items.trashTx(item.id);
  }
}
