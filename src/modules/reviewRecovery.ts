import type { BatchItemPreview } from "./batchTypes";
import { isBlockingAttemptOutcome, normalizeDOI, normalizeHTTPURL, type RouteId } from "./update/resolution";

/** 只读查找的恢复许可；渲染、事件和实际发起查找前共用，不能从提示文字猜原因。 */
export function getReviewRecovery(preview: BatchItemPreview): {
  retryRoute?: RouteId;
  canUseDOI: boolean;
  reason?: "unsupported" | "no-result" | "access-denied" | "rate-limited" | "invalid-response";
} {
  if (preview.status !== "failed" && preview.status !== "blocked") return { canUseDOI: false };
  const attempts = preview.attempts || [];
  const last = attempts.at(-1);
  const status = last?.diagnostic?.httpStatus;
  const reason = status === 429 ? "rate-limited"
    : status === 401 || status === 403 ? "access-denied"
    : last?.outcome === "unsupported" ? "unsupported"
    : last?.outcome === "no-result" ? "no-result"
    : last?.outcome === "invalid-response" ? "invalid-response" : undefined;
  // 身份冲突与确定性解析错误保持原拦截；拒绝/限流必须先解决访问条件。
  if (preview.status === "blocked" || preview.terminalOutcome === "blocked"
    || (last && isBlockingAttemptOutcome(last.outcome))
    || (status && status !== 408 && status !== 504)
    || last?.errorCode === "host-request-stopped") return { canUseDOI: false, reason };
  const transient = last && (last.outcome === "fetch-failed" || last.outcome === "retry-exhausted")
    && (last.retryable === true || last.outcome === "retry-exhausted")
    && (last.routeId === "doi.search" ? normalizeDOI(preview.normalizedDOI) : normalizeHTTPURL(preview.sourceURL));
  return {
    ...(transient ? { retryRoute: last.routeId } : {}),
    canUseDOI: Boolean(normalizeDOI(preview.normalizedDOI))
      && !attempts.some(attempt => attempt.routeId === "doi.search"),
    reason,
  };
}

export function canRefreshReview(preview: BatchItemPreview, doiOnly: boolean): boolean {
  const recovery = getReviewRecovery(preview);
  return doiOnly ? recovery.retryRoute === "doi.search" || recovery.canUseDOI
    : recovery.retryRoute === "url.web";
}
