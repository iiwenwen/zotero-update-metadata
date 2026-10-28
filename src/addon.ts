// Addon 实例（参考 template src/addon.ts，最小化）
import hooks, { buildBatchMenuEntries, canReviewBatchItems, canUseDOIRoute, resolveBatchMenuItems } from "./hooks";
import { diffFields } from "./modules/metadataSource";
import { preflightBatch, preflightDOIBatch, applyBatch, retryFailedBatch, buildFieldCandidates, buildAttachmentCandidates, buildNoteCandidates, isSameDoubanBook } from "./modules/batchSyncUpdate";
import { summarizeBatchPreviews, summarizeBatchSelections, formatBatchSelectionSummary, getBatchFieldDefaultChecked, buildBatchDialogLayout, collectBatchSelections, getBatchDialogOptions, showBatchConfirmDialog } from "./modules/batchConfirmDialog";
import { BatchJournal, MemoryBatchJournalStorage } from "./modules/batchJournal";
import {
  buildBatchStatusDialogLayout,
  formatBatchInspectionSource,
  getBatchOperationStatusLabel,
  getBatchStatusDialogOptions,
  getBatchStatusLabel,
  showBatchStatusDialog,
  summarizeBatchStatus,
} from "./modules/batchStatusDialog";
import {
  createJournalCallback,
  finalJournalStatus,
  getBatchRuntimeCapabilities,
  initializeBatchRuntimeState,
  inspectBatchStatus,
  refreshBatchRuntimeCapabilities,
  runBatchWorkflow,
  runDOIBatchWorkflow,
  retryLastFailedBatch,
  rollbackLatestBatch,
  resetBatchRuntimeForTests,
} from "./modules/batchRuntime";
import { UPDATE_OPERATION_KINDS, createChangePlan, isChangeOperation, toJournalOperationKind } from "./modules/update/contracts";
import { candidateToBatchPreview, selectionSourceEvidence, selectionsToChangePlan, snapshotProviderItem } from "./modules/update/planner";
import { createDoubanProvider, extractDoubanSubject } from "./modules/providers/doubanProvider";
import { createWebTranslatorAdapter } from "./modules/providers/webTranslator";
import { createSearchTranslatorAdapter } from "./modules/providers/searchTranslator";
import { createDOISearchRoute } from "./modules/providers/doiSearchRoute";
import { createURLWebRoute } from "./modules/providers/urlWebRoute";
import { createMockMetadataResolver } from "./modules/providers/mockMetadataResolver";
import { createDOIFallbackResolver } from "./modules/update/doiFallbackResolver";
import { ChangeExecutor } from "./modules/update/changeExecutor";
import { DefaultZoteroMutationPort, DefaultZoteroRollbackPort, DelegatingZoteroMutationPort } from "./modules/update/zoteroMutationPort";
import { ATTEMPT_OUTCOMES, ROUTE_IDS, classifyAttemptOutcome, createAttemptDiagnostic, createCandidateDigest, isBlockingAttemptOutcome, isFallbackAttemptOutcome, normalizeDOI } from "./modules/update/resolution";
import { BatchPreflightCancelledError, PREFLIGHT_PROGRESS_STAGES } from "./modules/batchTypes";
import { getReviewSelectionDefaults } from "./modules/reviewSelectionDefaults";
import { getWorkflowActivity, subscribeWorkflowActivity, tryAcquireWorkflowActivity } from "./modules/workflowActivity";
import {
  buildBatchPreflightDialogLayout,
  getBatchPreflightDialogOptions,
  openBatchPreflightDialog,
  reduceBatchPreflightViewState,
} from "./modules/batchPreflightDialog";

declare const __testBuild__: boolean;

class Addon {
  public data: {
    alive: boolean;
    initialized: boolean;
    ztoolkit: any;
    rootURI?: string;
  };
  public hooks: typeof hooks;
  public api: {
    diffFields: typeof diffFields;
    preflightBatch: typeof preflightBatch;
    buildFieldCandidates: typeof buildFieldCandidates;
    buildAttachmentCandidates: typeof buildAttachmentCandidates;
    buildNoteCandidates: typeof buildNoteCandidates;
    isSameDoubanBook: typeof isSameDoubanBook;
    summarizeBatchPreviews: typeof summarizeBatchPreviews;
    summarizeBatchSelections: typeof summarizeBatchSelections;
    formatBatchSelectionSummary: typeof formatBatchSelectionSummary;
    getBatchFieldDefaultChecked: typeof getBatchFieldDefaultChecked;
    buildBatchDialogLayout: typeof buildBatchDialogLayout;
    collectBatchSelections: typeof collectBatchSelections;
    getBatchDialogOptions: typeof getBatchDialogOptions;
    showBatchConfirmDialog: typeof showBatchConfirmDialog;
    BatchJournal: typeof BatchJournal;
    MemoryBatchJournalStorage: typeof MemoryBatchJournalStorage;
    runBatchWorkflow: typeof runBatchWorkflow;
    retryLastFailedBatch: typeof retryLastFailedBatch;
    rollbackLatestBatch: typeof rollbackLatestBatch;
    resetBatchRuntimeForTests: typeof resetBatchRuntimeForTests;
    createJournalCallback: typeof createJournalCallback;
    finalJournalStatus: typeof finalJournalStatus;
    getBatchRuntimeCapabilities: typeof getBatchRuntimeCapabilities;
    refreshBatchRuntimeCapabilities: typeof refreshBatchRuntimeCapabilities;
    initializeBatchRuntimeState: typeof initializeBatchRuntimeState;
    inspectBatchStatus: typeof inspectBatchStatus;
    buildBatchMenuEntries: typeof buildBatchMenuEntries;
    resolveBatchMenuItems: typeof resolveBatchMenuItems;
    canReviewBatchItems: typeof canReviewBatchItems;
    canUseDOIRoute: typeof canUseDOIRoute;
    UPDATE_OPERATION_KINDS: typeof UPDATE_OPERATION_KINDS;
    createChangePlan: typeof createChangePlan;
    isChangeOperation: typeof isChangeOperation;
    toJournalOperationKind: typeof toJournalOperationKind;
    snapshotProviderItem: typeof snapshotProviderItem;
    candidateToBatchPreview: typeof candidateToBatchPreview;
    selectionsToChangePlan: typeof selectionsToChangePlan;
    selectionSourceEvidence: typeof selectionSourceEvidence;
    createDoubanProvider: typeof createDoubanProvider;
    extractDoubanSubject: typeof extractDoubanSubject;
    createWebTranslatorAdapter: typeof createWebTranslatorAdapter;
    ATTEMPT_OUTCOMES: typeof ATTEMPT_OUTCOMES;
    ROUTE_IDS: typeof ROUTE_IDS;
    classifyAttemptOutcome: typeof classifyAttemptOutcome;
    createCandidateDigest: typeof createCandidateDigest;
    isBlockingAttemptOutcome: typeof isBlockingAttemptOutcome;
    isFallbackAttemptOutcome: typeof isFallbackAttemptOutcome;
    normalizeDOI: typeof normalizeDOI;
    BatchPreflightCancelledError: typeof BatchPreflightCancelledError;
    PREFLIGHT_PROGRESS_STAGES: typeof PREFLIGHT_PROGRESS_STAGES;
    buildBatchPreflightDialogLayout: typeof buildBatchPreflightDialogLayout;
    getBatchPreflightDialogOptions: typeof getBatchPreflightDialogOptions;
    openBatchPreflightDialog: typeof openBatchPreflightDialog;
    reduceBatchPreflightViewState: typeof reduceBatchPreflightViewState;
    buildBatchStatusDialogLayout: typeof buildBatchStatusDialogLayout;
    formatBatchInspectionSource: typeof formatBatchInspectionSource;
    getBatchOperationStatusLabel: typeof getBatchOperationStatusLabel;
    getBatchStatusDialogOptions: typeof getBatchStatusDialogOptions;
    getBatchStatusLabel: typeof getBatchStatusLabel;
    showBatchStatusDialog: typeof showBatchStatusDialog;
    summarizeBatchStatus: typeof summarizeBatchStatus;
  };
  /** 仅测试构建存在；生产包不暴露可绕过正常工作流的写入能力。 */
  public testApi?: {
    getReviewSelectionDefaults: typeof getReviewSelectionDefaults;
    getWorkflowActivity: typeof getWorkflowActivity;
    subscribeWorkflowActivity: typeof subscribeWorkflowActivity;
    tryAcquireWorkflowActivity: typeof tryAcquireWorkflowActivity;
    runDOIBatchWorkflow: typeof runDOIBatchWorkflow;
    ChangeExecutor: typeof ChangeExecutor;
    DefaultZoteroMutationPort: typeof DefaultZoteroMutationPort;
    DefaultZoteroRollbackPort: typeof DefaultZoteroRollbackPort;
    DelegatingZoteroMutationPort: typeof DelegatingZoteroMutationPort;
    applyBatch: typeof applyBatch;
    preflightDOIBatch: typeof preflightDOIBatch;
    retryFailedBatch: typeof retryFailedBatch;
    createSearchTranslatorAdapter: typeof createSearchTranslatorAdapter;
    createDOISearchRoute: typeof createDOISearchRoute;
    createURLWebRoute: typeof createURLWebRoute;
    createMockMetadataResolver: typeof createMockMetadataResolver;
    createDOIFallbackResolver: typeof createDOIFallbackResolver;
    createAttemptDiagnostic: typeof createAttemptDiagnostic;
  };

  constructor() {
    this.data = {
      alive: true,
      initialized: false,
      // macOS可仅有设置／测试窗口；Toolkit依赖主窗口，待窗口加载后创建。
      ztoolkit: null,
    };
    this.hooks = hooks;
    // 暴露功能层给测试/UI 用（架构规约：功能层独立，api 是访问口）
    this.api = {
      diffFields,
      preflightBatch,
      buildFieldCandidates,
      buildAttachmentCandidates,
      buildNoteCandidates,
      isSameDoubanBook,
      summarizeBatchPreviews,
      summarizeBatchSelections,
      formatBatchSelectionSummary,
      getBatchFieldDefaultChecked,
      buildBatchDialogLayout,
      collectBatchSelections,
      getBatchDialogOptions,
      showBatchConfirmDialog,
      BatchJournal,
      MemoryBatchJournalStorage,
      runBatchWorkflow,
      retryLastFailedBatch,
      rollbackLatestBatch,
      resetBatchRuntimeForTests,
      createJournalCallback,
      finalJournalStatus,
      getBatchRuntimeCapabilities,
      refreshBatchRuntimeCapabilities,
      initializeBatchRuntimeState,
      inspectBatchStatus,
      buildBatchMenuEntries,
      resolveBatchMenuItems,
      canReviewBatchItems,
      canUseDOIRoute,
      UPDATE_OPERATION_KINDS,
      createChangePlan,
      isChangeOperation,
      toJournalOperationKind,
      snapshotProviderItem,
      candidateToBatchPreview,
      selectionsToChangePlan,
      selectionSourceEvidence,
      createDoubanProvider,
      extractDoubanSubject,
      createWebTranslatorAdapter,
      ATTEMPT_OUTCOMES,
      ROUTE_IDS,
      classifyAttemptOutcome,
      createCandidateDigest,
      isBlockingAttemptOutcome,
      isFallbackAttemptOutcome,
      normalizeDOI,
      BatchPreflightCancelledError,
      PREFLIGHT_PROGRESS_STAGES,
      buildBatchPreflightDialogLayout,
      getBatchPreflightDialogOptions,
      openBatchPreflightDialog,
      reduceBatchPreflightViewState,
      buildBatchStatusDialogLayout,
      formatBatchInspectionSource,
      getBatchOperationStatusLabel,
      getBatchStatusDialogOptions,
      getBatchStatusLabel,
      showBatchStatusDialog,
      summarizeBatchStatus,
    };
    if (__testBuild__) {
      this.testApi = {
        getReviewSelectionDefaults,
        getWorkflowActivity,
        subscribeWorkflowActivity,
        tryAcquireWorkflowActivity,
        runDOIBatchWorkflow,
        ChangeExecutor,
        DefaultZoteroMutationPort,
        DefaultZoteroRollbackPort,
        DelegatingZoteroMutationPort,
        applyBatch,
        preflightDOIBatch,
        retryFailedBatch,
        createSearchTranslatorAdapter,
        createDOISearchRoute,
        createURLWebRoute,
        createMockMetadataResolver,
        createDOIFallbackResolver,
        createAttemptDiagnostic,
      };
    }
  }
}

export default Addon;
