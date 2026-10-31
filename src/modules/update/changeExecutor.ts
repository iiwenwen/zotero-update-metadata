import { localized } from "../../utils/locale";
import {
  ChangeExecutionError,
  isChangeOperation,
  type AttachmentCreateOperation,
  type ChangeExecutionResult,
  type ChangeOperation,
  type ChangeOperationResult,
  type ChangePlan,
  type CandidateCreator,
  type CreatorsSetOperation,
  type FieldSetOperation,
  type ItemChangeResult,
  type MetadataItemRef,
  type NoteCreateOperation,
  type ZoteroMutationPort,
} from "./contracts";
import {
  AttachmentMutationHandler,
  CreatorMutationHandler,
  FieldMutationHandler,
  NoteMutationHandler,
  invalidOperationMessage,
  type ChangeOperationEventCallback,
  type MutationHandlerContext,
} from "./mutationHandlers";

function failedResult(operation: ChangeOperation, message: string): ChangeOperationResult {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    status: "failed",
    message,
  };
}

function itemStatus(operations: readonly ChangeOperationResult[]): ItemChangeResult["status"] {
  if (operations.length === 0) return "skipped";
  const applied = operations.some((operation) => operation.status === "applied");
  const failed = operations.some((operation) => operation.status === "failed");
  if (applied && failed) return "partial";
  if (failed) return "failed";
  return "applied";
}

function assertValidPlan(plan: ChangePlan): void {
  if (!plan || typeof plan !== "object" || typeof plan.planId !== "string" || !Array.isArray(plan.items)) {
    throw new ChangeExecutionError("invalid-plan", localized("更新计划无效，未执行", "The update plan is invalid and was not run."));
  }
  for (const itemPlan of plan.items) {
    if (!itemPlan?.item || !Array.isArray(itemPlan.operations) || !Array.isArray(itemPlan.evidence)) {
      throw new ChangeExecutionError("invalid-plan", localized("条目的更新计划无效，未执行", "The item update plan is invalid and was not run."));
    }
    if (itemPlan.operations.length > 0 && (
      itemPlan.evidence.length === 0
      || itemPlan.evidence.some((evidence) =>
        !evidence
        || typeof evidence.providerId !== "string"
        || evidence.providerId.length === 0
        || typeof evidence.sourceURL !== "string"
        || evidence.sourceURL.length === 0
        || typeof evidence.fetchedAt !== "string"
        || evidence.fetchedAt.length === 0
        || !Array.isArray(evidence.identifiers)
        || evidence.identifiers.some((identifier) =>
          !identifier
          || typeof identifier.type !== "string"
          || identifier.type.length === 0
          || typeof identifier.value !== "string"
          || identifier.value.length === 0)
      )
    )) {
      throw new ChangeExecutionError("invalid-plan", localized(`条目缺少有效来源，未执行更新：${itemPlan.item.itemKey}`, `The item has no verified source. Nothing was updated: ${itemPlan.item.itemKey}`));
    }
    const operationIds = new Set<string>();
    let creatorsOperationCount = 0;
    for (const operation of itemPlan.operations) {
      if (!isChangeOperation(operation)) {
        throw new ChangeExecutionError("invalid-plan", localized("更新计划包含无法识别的操作，未执行", "The update plan contains an unknown operation and was not run."));
      }
      if (operationIds.has(operation.operationId)) {
        throw new ChangeExecutionError(
          "invalid-plan",
          localized(`更新计划存在重复操作，未执行：${operation.operationId}`, `The update plan contains a duplicate operation and was not run: ${operation.operationId}`),
          operation.operationId,
        );
      }
      if (operation.kind === "creators-set" && ++creatorsOperationCount > 1) {
        throw new ChangeExecutionError(
          "invalid-plan",
          localized(`同一条目不能重复更新作者与贡献者：${itemPlan.item.itemKey}`, `The authors and contributors cannot be updated twice for the same item: ${itemPlan.item.itemKey}`),
          operation.operationId,
        );
      }
      operationIds.add(operation.operationId);
    }
  }
}

/**
 * 唯一写入执行器：只接收审核完成的 ChangePlan，不读取 Provider 或 UI 数据。
 * 同一条目字段聚合保存；附件与 Note 保持逐项失败隔离。
 */
export class ChangeExecutor<TItem = unknown, TCreatedItem = unknown> {
  private readonly fieldHandler: FieldMutationHandler<TItem, TCreatedItem>;
  private readonly creatorHandler: CreatorMutationHandler<TItem, TCreatedItem>;
  private readonly attachmentHandler: AttachmentMutationHandler<TItem, TCreatedItem>;
  private readonly noteHandler: NoteMutationHandler<TItem, TCreatedItem>;

  constructor(
    private readonly port: ZoteroMutationPort<TItem, TCreatedItem>,
    private readonly onOperationStatus?: ChangeOperationEventCallback,
    private readonly beforeWrite?: (ref: MetadataItemRef, item: TItem, appliedFields: ReadonlyMap<string, unknown>, appliedCreators?: readonly CandidateCreator[]) => void,
  ) {
    this.fieldHandler = new FieldMutationHandler(port);
    this.creatorHandler = new CreatorMutationHandler(port);
    this.attachmentHandler = new AttachmentMutationHandler(port);
    this.noteHandler = new NoteMutationHandler(port);
  }

  async execute(plan: ChangePlan): Promise<ChangeExecutionResult> {
    assertValidPlan(plan);
    const items: ItemChangeResult[] = [];
    for (const itemPlan of plan.items) {
      items.push(await this.executeItem(plan.planId, itemPlan));
    }
    return { planId: plan.planId, items };
  }

  private async executeItem(
    planId: string,
    itemPlan: ChangePlan["items"][number],
  ): Promise<ItemChangeResult> {
    if (itemPlan.operations.length === 0) {
      return { item: itemPlan.item, status: "skipped", operations: [] };
    }

    let item: TItem | null;
    try {
      item = await this.port.getItem(itemPlan.item);
      if (!item) {
        throw new ChangeExecutionError(
          "item-not-found",
          localized(`找不到条目：${itemPlan.item.itemKey}`, `The item could not be found: ${itemPlan.item.itemKey}`),
        );
      }
    } catch (error) {
      const message = invalidOperationMessage(error);
      return {
        item: itemPlan.item,
        status: "failed",
        operations: itemPlan.operations.map((operation) => failedResult(operation, message)),
        message,
      };
    }

    const appliedFields = new Map<string, unknown>();
    let appliedCreators: readonly CandidateCreator[] | undefined;
    const context: MutationHandlerContext<TItem> = {
      planId,
      itemRef: itemPlan.item,
      item,
      onOperationStatus: async (event) => {
        if (event.operation.kind === "field-set" && event.status === "failed") appliedFields.delete(event.operation.field);
        if (event.operation.kind === "creators-set" && event.status === "failed") appliedCreators = undefined;
        const capturedCreators = event.operation.kind === "creators-set" && event.status === "applied"
          ? (event.actualAfter as readonly CandidateCreator[]).map((creator) => ({ ...creator })) : undefined;
        await this.onOperationStatus?.(event);
        if (event.operation.kind === "field-set" && event.status === "applied") {
          appliedFields.set(event.operation.field, event.actualAfter);
        }
        if (capturedCreators) appliedCreators = capturedCreators;
      },
      beforeWrite: (pendingFields, pendingCreators) => {
        this.beforeWrite?.(itemPlan.item, item!, new Map([...appliedFields, ...(pendingFields || [])]), pendingCreators ?? appliedCreators);
      },
    };
    const byOperationId = new Map<string, ChangeOperationResult>();
    const fields = itemPlan.operations.filter(
      (operation): operation is FieldSetOperation => operation.kind === "field-set",
    );
    const attachments = itemPlan.operations.filter(
      (operation): operation is AttachmentCreateOperation => operation.kind === "attachment-create",
    );
    const notes = itemPlan.operations.filter(
      (operation): operation is NoteCreateOperation => operation.kind === "note-create",
    );
    const creators = itemPlan.operations.filter(
      (operation): operation is CreatorsSetOperation => operation.kind === "creators-set",
    );

    for (const operationResult of await this.fieldHandler.execute(fields, context)) {
      byOperationId.set(operationResult.operationId, operationResult);
    }
    for (const operation of creators) {
      const operationResult = await this.creatorHandler.execute(operation, context);
      byOperationId.set(operationResult.operationId, operationResult);
    }
    for (const operation of attachments) {
      const operationResult = await this.attachmentHandler.execute(operation, context);
      byOperationId.set(operationResult.operationId, operationResult);
    }
    for (const operation of notes) {
      const operationResult = await this.noteHandler.execute(operation, context);
      byOperationId.set(operationResult.operationId, operationResult);
    }

    const operations = itemPlan.operations.map((operation) => byOperationId.get(operation.operationId)!);
    return {
      item: itemPlan.item,
      status: itemStatus(operations),
      operations,
    };
  }
}
