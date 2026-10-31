import { localized } from "../../utils/locale";
import {
  ChangeExecutionError,
  type AttachmentCreateOperation,
  type CandidateCreator,
  type ChangeOperationEvent,
  type ChangeOperationResult,
  type CreatorsSetOperation,
  type FieldSetOperation,
  type MetadataItemRef,
  type NoteCreateOperation,
  type ZoteroMutationPort,
} from "./contracts";

export type ChangeOperationEventCallback = (
  event: ChangeOperationEvent,
) => Promise<void> | void;

export interface MutationHandlerContext<TItem> {
  readonly planId: string;
  readonly itemRef: MetadataItemRef;
  readonly item: TItem;
  readonly onOperationStatus?: ChangeOperationEventCallback;
  /** 必须同步；最后一次身份复核到实际写入之间不再 await。 */
  readonly beforeWrite?: (pendingFields?: ReadonlyMap<string, unknown>, pendingCreators?: readonly CandidateCreator[]) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 用户提示与原始异常分开；完整异常留在插件调试日志，写入状态由结构化字段判定。 */
function failureMessage(zh: string, en: string, ...causes: unknown[]): string {
  try { Zotero.debug(`[zmta] ${causes.filter(cause => cause !== undefined).map(errorMessage).join(" | ")}`); }
  catch { /* 诊断输出不能影响更新结果。 */ }
  return localized(zh, en);
}

function sameFieldValue(left: unknown, right: unknown): boolean {
  return String(left ?? "") === String(right ?? "");
}

function result(
  operation: FieldSetOperation | CreatorsSetOperation | AttachmentCreateOperation | NoteCreateOperation,
  status: "applied" | "failed",
  message?: string,
  recoveryRequired = false,
): ChangeOperationResult {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    status,
    ...(message ? { message } : {}),
    ...(recoveryRequired ? { recoveryRequired: true } : {}),
  };
}

async function emit<TItem>(
  context: MutationHandlerContext<TItem>,
  operation: FieldSetOperation | CreatorsSetOperation | AttachmentCreateOperation | NoteCreateOperation,
  status: ChangeOperationEvent["status"],
  details: Pick<ChangeOperationEvent, "actualAfter" | "createdItemKey" | "createdItemFingerprint" | "message" | "recoveryRequired"> = {},
): Promise<void> {
  if (!context.onOperationStatus) return;
  await context.onOperationStatus({
    planId: context.planId,
    item: context.itemRef,
    operation,
    status,
    ...details,
  });
}

async function emitFailureBestEffort<TItem>(
  context: MutationHandlerContext<TItem>,
  operation: FieldSetOperation | CreatorsSetOperation | AttachmentCreateOperation | NoteCreateOperation,
  message: string,
  details: Pick<ChangeOperationEvent, "actualAfter" | "createdItemKey" | "createdItemFingerprint" | "recoveryRequired"> = {},
): Promise<void> {
  try {
    await emit(context, operation, "failed", { ...details, message });
  } catch {
    // 写入结果已经确定，不能让失败日志再次失败阻断其他操作。
  }
}

function sameCreators(
  left: readonly CandidateCreator[],
  right: readonly CandidateCreator[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((creator, index) => {
    const other = right[index];
    if (!other) return false;
    return creator.creatorType === other.creatorType
      && creator.firstName === other.firstName
      && creator.lastName === other.lastName
      && creator.name === other.name;
  });
}

interface PlannedField {
  readonly operation: FieldSetOperation;
}

/** 字段按条目统一复核、统一保存，避免多字段写入窗口扩大。 */
export class FieldMutationHandler<TItem, TCreatedItem> {
  constructor(private readonly port: ZoteroMutationPort<TItem, TCreatedItem>) {}

  async execute(
    operations: readonly FieldSetOperation[],
    context: MutationHandlerContext<TItem>,
  ): Promise<ChangeOperationResult[]> {
    const byOperationId = new Map<string, ChangeOperationResult>();
    const planned: PlannedField[] = [];
    const lateFailures: { operation: FieldSetOperation; message: string }[] = [];
    const finish = async () => {
      for (const { operation, message } of lateFailures) await emitFailureBestEffort(context, operation, message);
      return operations.map((operation) => byOperationId.get(operation.operationId)!);
    };

    // 先把全部写前意图落日志，再读取任何当前值。
    for (const operation of operations) {
      try {
        await emit(context, operation, "planned");
        planned.push({ operation });
      } catch (error) {
        byOperationId.set(
          operation.operationId,
          result(operation, "failed", failureMessage("无法保存更新记录。此项更新未执行。", "The update record could not be saved. This change was not applied.", error)),
        );
      }
    }

    // planned 完成后统一重读；冲突只淘汰当前字段，不影响同条目的其他字段。
    const verified: PlannedField[] = [];
    for (const state of planned) {
      const { operation } = state;
      let current: unknown;
      try {
        current = this.port.getField(context.item, operation.field);
      } catch (error) {
        const message = localized(`无法重新读取字段：${errorMessage(error)}`, `Could not reread the field: ${errorMessage(error)}`);
        byOperationId.set(operation.operationId, result(operation, "failed", message));
        await emitFailureBestEffort(context, operation, message);
        continue;
      }
      if (!sameFieldValue(current, operation.before)) {
        const message = localized("此字段在审核后已被修改。本次未覆盖。", "This field changed after review. It was not overwritten.");
        byOperationId.set(operation.operationId, result(operation, "failed", message));
        await emitFailureBestEffort(context, operation, message, { actualAfter: current });
        continue;
      }
      verified.push(state);
    }

    if (verified.length === 0) {
      return operations.map((operation) => byOperationId.get(operation.operationId)!);
    }

    let writeError: unknown;
    const written: PlannedField[] = [];
    const actualAfter = new Map<string, unknown>();
    let captureError: unknown;
    try {
      // 上方失败日志可能 await；最后一次比较到 set 之间不得再让出执行权。
      const finalVerified = verified.filter(({ operation }) => {
        const current = this.port.getField(context.item, operation.field);
        if (sameFieldValue(current, operation.before)) return true;
        const message = localized("此字段在审核后已被修改。本次未覆盖。", "This field changed after review. It was not overwritten.");
        byOperationId.set(operation.operationId, result(operation, "failed", message));
        lateFailures.push({ operation, message });
        return false;
      });
      verified.splice(0, verified.length, ...finalVerified);
      if (verified.length === 0) return finish();
      context.beforeWrite?.();
      for (const { operation } of verified) {
        written.push({ operation });
        this.port.setField(context.item, operation.field, operation.after);
      }
      const saving = this.port.saveItem(context.item);
      // 捕获 save 调用同步段的规范化结果；首次 await 后的新值不能归因为本次保存。
      try {
        for (const { operation } of verified) actualAfter.set(operation.operationId, this.port.getField(context.item, operation.field));
      } catch (error) { captureError = error; }
      await saving;
    } catch (error) {
      writeError = error;
    }

    if (writeError) {
      const message = failureMessage("无法保存此项内容。请查看更新记录。", "This content could not be saved. View update history.", writeError);
      // save 未成功时只恢复当前对象，避免为了清理内存状态再产生一次库写入。
      for (const { operation } of verified) {
        try {
          if (written.some((state) => state.operation === operation)
            && sameFieldValue(this.port.getField(context.item, operation.field), actualAfter.has(operation.operationId) ? actualAfter.get(operation.operationId) : operation.after)) {
            this.port.setField(context.item, operation.field, operation.before);
          }
        } catch {
          // 原写入已失败，后续操作仍应继续。
        }
        byOperationId.set(operation.operationId, result(operation, "failed", message));
        await emitFailureBestEffort(context, operation, message);
      }
      return finish();
    }

    let postWriteError: unknown;
    try {
      if (captureError) throw captureError;
      for (const { operation } of verified) {
        if (!actualAfter.has(operation.operationId) || !sameFieldValue(this.port.getField(context.item, operation.field), actualAfter.get(operation.operationId))) {
          throw new Error(localized("保存期间字段已变化，已保留当前内容", "The field changed while saving. Its current value was kept."));
        }
      }
      context.beforeWrite?.(new Map(verified.map(({ operation }) => [operation.field, actualAfter.get(operation.operationId)])));
      for (const { operation } of verified) {
        await emit(context, operation, "applied", {
          actualAfter: actualAfter.get(operation.operationId),
        });
      }
    } catch (error) {
      postWriteError = error;
    }

    if (!postWriteError) {
      for (const { operation } of verified) {
        byOperationId.set(operation.operationId, result(operation, "applied"));
      }
      return finish();
    }

    let compensationError: unknown;
    try {
      for (const { operation } of verified) {
        if (!actualAfter.has(operation.operationId)
          || !sameFieldValue(this.port.getField(context.item, operation.field), actualAfter.get(operation.operationId))) {
          throw new Error(localized("无法安全恢复字段，已保留当前内容", "The field could not be safely restored. Its current value was kept."));
        }
      }
      for (const { operation } of verified) {
        this.port.setField(context.item, operation.field, operation.before);
      }
      await this.port.saveItem(context.item);
    } catch (error) {
      compensationError = error;
    }

    const message = compensationError
      ? failureMessage("此项更新的实际结果需人工核对。请查看更新记录。请勿重复执行此项更新。", "The actual result requires manual review. View update history. Do not repeat this change.", postWriteError, compensationError)
      : failureMessage("无法记录或核对此项更新结果。已恢复更新前的内容。", "The result could not be recorded or verified. The original content was restored.", postWriteError);
    for (const { operation } of verified) {
      byOperationId.set(operation.operationId, result(operation, "failed", message, Boolean(compensationError)));
      await emitFailureBestEffort(context, operation, message, {
        actualAfter: actualAfter.get(operation.operationId),
        ...(compensationError ? { recoveryRequired: true } : {}),
      });
    }
    return finish();
  }
}

/** Creator 是一个完整有序列表；写入、冲突判断与补偿均以整组为单位。 */
export class CreatorMutationHandler<TItem, TCreatedItem> {
  constructor(private readonly port: ZoteroMutationPort<TItem, TCreatedItem>) {}

  async execute(
    operation: CreatorsSetOperation,
    context: MutationHandlerContext<TItem>,
  ): Promise<ChangeOperationResult> {
    try {
      await emit(context, operation, "planned");
    } catch (error) {
      return result(operation, "failed", failureMessage("无法保存更新记录。此项更新未执行。", "The update record could not be saved. This change was not applied.", error));
    }

    let current: readonly CandidateCreator[];
    try {
      context.beforeWrite?.();
      current = this.port.getCreators(context.item);
    } catch (error) {
      const message = localized(`无法重新读取作者与贡献者名单：${errorMessage(error)}`, `Could not reread the authors and contributors: ${errorMessage(error)}`);
      await emitFailureBestEffort(context, operation, message);
      return result(operation, "failed", message);
    }
    if (!sameCreators(current, operation.before)) {
      const message = localized("作者与贡献者名单在审核后已被修改。本次未覆盖。", "The authors and contributors changed after review. They were not overwritten.");
      await emitFailureBestEffort(context, operation, message, { actualAfter: current });
      return result(operation, "failed", message);
    }

    let writeError: unknown;
    let actualAfter: readonly CandidateCreator[] | undefined;
    let captureError: unknown;
    try {
      this.port.setCreators(context.item, operation.after);
      const saving = this.port.saveItem(context.item);
      try { actualAfter = this.port.getCreators(context.item).map((creator) => ({ ...creator })); }
      catch (error) { captureError = error; }
      await saving;
    } catch (error) {
      writeError = error;
    }

    if (writeError) {
      const message = failureMessage("无法保存此项内容。请查看更新记录。", "This content could not be saved. View update history.", writeError);
      try {
        if (sameCreators(this.port.getCreators(context.item), actualAfter || operation.after)) {
          this.port.setCreators(context.item, operation.before);
        }
      } catch {
        // save 未成功时只尽力恢复当前内存对象，不追加一次库写入。
      }
      await emitFailureBestEffort(context, operation, message);
      return result(operation, "failed", message);
    }

    let postWriteError: unknown;
    try {
      if (captureError) throw captureError;
      if (!actualAfter || !sameCreators(this.port.getCreators(context.item), actualAfter)) {
        throw new Error(localized("保存期间作者与贡献者已变化，已保留当前名单", "The authors and contributors changed while saving. The current list was kept."));
      }
      context.beforeWrite?.(undefined, actualAfter);
      await emit(context, operation, "applied", { actualAfter });
    } catch (error) {
      postWriteError = error;
    }

    if (!postWriteError) return result(operation, "applied");

    let compensationError: unknown;
    try {
      if (!actualAfter || !sameCreators(this.port.getCreators(context.item), actualAfter)) {
        throw new Error(localized("无法安全恢复作者与贡献者，已保留当前名单", "The authors and contributors could not be safely restored. The current list was kept."));
      }
      this.port.setCreators(context.item, operation.before);
      await this.port.saveItem(context.item);
    } catch (error) {
      compensationError = error;
    }

    const message = compensationError
      ? failureMessage("此项更新的实际结果需人工核对。请查看更新记录。请勿重复执行此项更新。", "The actual result requires manual review. View update history. Do not repeat this change.", postWriteError, compensationError)
      : failureMessage("无法记录或核对此项更新结果。已恢复更新前的内容。", "The result could not be recorded or verified. The original content was restored.", postWriteError);
    await emitFailureBestEffort(context, operation, message, { actualAfter, ...(compensationError ? { recoveryRequired: true } : {}) });
    return result(operation, "failed", message, Boolean(compensationError));
  }
}

abstract class CreatedItemMutationHandler<
  TItem,
  TCreatedItem,
  TOperation extends AttachmentCreateOperation | NoteCreateOperation,
> {
  constructor(protected readonly port: ZoteroMutationPort<TItem, TCreatedItem>) {}

  protected abstract create(item: TItem, operation: TOperation): Promise<TCreatedItem>;
  protected abstract noun(): string;

  async execute(
    operation: TOperation,
    context: MutationHandlerContext<TItem>,
  ): Promise<ChangeOperationResult> {
    try {
      await emit(context, operation, "planned");
    } catch (error) {
      return result(operation, "failed", failureMessage("无法保存更新记录。此项更新未执行。", "The update record could not be saved. This change was not applied.", error));
    }

    let created: TCreatedItem;
    try {
      context.beforeWrite?.();
      created = await this.create(context.item, operation);
    } catch (error) {
      const message = failureMessage("无法保存此项内容。请查看更新记录。", "This content could not be saved. View update history.", error);
      await emitFailureBestEffort(context, operation, message);
      return result(operation, "failed", message);
    }

    let createdItemKey: string | undefined;
    let createdItemFingerprint: string | undefined;
    try {
      createdItemKey = this.port.getCreatedItemKey(created);
      createdItemFingerprint = this.port.getCreatedItemCreationFingerprint?.(created);
      context.beforeWrite?.();
      await emit(context, operation, "applied", { createdItemKey, createdItemFingerprint,
        ...(!createdItemFingerprint ? { message: localized("无法确认新增内容的初始状态，撤销时会保留该内容", "The initial state of this new content could not be verified. It will be kept when undoing.") } : {}),
      });
      return result(operation, "applied");
    } catch (journalError) {
      let compensationError: unknown;
      try {
        if (!createdItemFingerprint) throw new ChangeExecutionError("conflict", localized("无法确认新增内容是否已被改动，已保留", "The new content was kept because its initial state could not be verified."));
        await this.port.trashCreatedItem(created, createdItemFingerprint);
      } catch (error) {
        compensationError = error;
      }

      const message = compensationError
        ? failureMessage("此项更新的实际结果需人工核对。请查看更新记录。请勿重复执行此项更新。", "The actual result requires manual review. View update history. Do not repeat this change.", journalError, compensationError)
        : failureMessage(`无法记录或核对新增结果。新增${this.noun()}已移入回收站。`, `The new content could not be recorded or verified. The new ${this.noun()} was moved to the trash.`, journalError);
      await emitFailureBestEffort(context, operation, message, { createdItemKey, createdItemFingerprint,
        ...(compensationError ? { recoveryRequired: true } : {}),
      });
      return result(operation, "failed", message, Boolean(compensationError));
    }
  }
}

export class AttachmentMutationHandler<TItem, TCreatedItem>
  extends CreatedItemMutationHandler<TItem, TCreatedItem, AttachmentCreateOperation> {
  protected create(item: TItem, operation: AttachmentCreateOperation): Promise<TCreatedItem> {
    return this.port.createAttachment(item, operation.attachment);
  }

  protected noun(): string {
    return localized("附件", "attachment");
  }
}

export class NoteMutationHandler<TItem, TCreatedItem>
  extends CreatedItemMutationHandler<TItem, TCreatedItem, NoteCreateOperation> {
  protected create(item: TItem, operation: NoteCreateOperation): Promise<TCreatedItem> {
    return this.port.createNote(item, operation.content);
  }

  protected noun(): string {
    return localized("笔记", "note");
  }
}

export function invalidOperationMessage(error: unknown): string {
  return error instanceof ChangeExecutionError
    ? error.message
    : localized(`执行失败：${errorMessage(error)}`, `The operation failed: ${errorMessage(error)}`);
}
