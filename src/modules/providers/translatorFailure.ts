declare const Zotero: any;

import {
  createAttemptDiagnostic,
  type AttemptDiagnostic,
  type AttemptStage,
} from "../update/resolution";

export class TranslatorAdapterError<Code extends string> extends Error {
  public readonly diagnostic: AttemptDiagnostic;

  constructor(
    name: string,
    public readonly code: Code,
    message: string,
    public readonly retryable: boolean,
    stage: AttemptStage,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = name;
    if (options && "cause" in options) (this as Error & { cause?: unknown }).cause = options.cause;
    this.diagnostic = createAttemptDiagnostic(stage, message, options?.cause);
    const status = this.diagnostic.httpStatus;
    // HTTP 拒绝／限流和其他明确 HTTP 错误不立即重放；408/504 仍允许一次超时重试。
    if (status && status !== 408 && status !== 504) this.retryable = false;
    if (!status && !/offline|network|time.?out|timed out|NS_ERROR_NET|NS_ERROR_UNKNOWN_HOST|E(?:TIMEDOUT|CONN|NET|HOST)|网络|超时/i.test(this.diagnostic.message)) {
      this.retryable = false;
    }
  }
}

export function debugTranslatorFailure(
  routeId: string,
  input: Readonly<Record<string, string>>,
  error: TranslatorAdapterError<string>,
): void {
  try {
    Zotero.debug(`[zmta:${routeId}] ${JSON.stringify({
      ...input,
      code: error.code,
      retryable: error.retryable,
      ...error.diagnostic,
      stack: (error as Error & { cause?: Error }).cause?.stack,
    })}`);
  } catch {
    // 诊断输出本身不得影响路线终态。
  }
}
