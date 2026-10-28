import type { ProviderItemSnapshot } from "./provider";
import {
  isBlockingAttemptOutcome,
  isFallbackAttemptOutcome,
  normalizeDOI,
  normalizeHTTPURL,
  type AttemptEvidence,
  type AttemptDiagnostic,
  type ResolutionResult,
  type ResolutionRoute,
  type RouteAttemptRequest,
} from "./resolution";

export interface DOIResolutionRequest {
  readonly item: ProviderItemSnapshot;
  readonly url?: unknown;
  readonly doi?: unknown;
  /** 每次实际路线请求前调用；可用于进度通知与协作取消。 */
  readonly beforeAttempt?: (routeId: ResolutionRoute["id"], attempt: number) => Promise<void> | void;
}

export interface DOIFallbackResolverOptions {
  readonly urlWebRoute: ResolutionRoute;
  readonly doiSearchRoute: ResolutionRoute;
  /** 保留为可注入时钟入口；每次实际尝试的时间仍以 route evidence 为准。 */
  readonly now?: () => string;
}

export interface DOIFallbackResolver {
  resolve(request: DOIResolutionRequest): Promise<ResolutionResult>;
  /** 用户明确改用 DOI 时，只运行 Search，不把该选择扩散到下游合同。 */
  resolveDOI(request: DOIResolutionRequest): Promise<ResolutionResult>;
}

interface RouteRun {
  readonly candidate: ResolutionResult["candidate"];
  readonly attempts: readonly AttemptEvidence[];
  readonly finalEvidence: AttemptEvidence;
}

function freezeResult(result: ResolutionResult): ResolutionResult {
  return Object.freeze({
    ...result,
    attempts: Object.freeze([...result.attempts]),
  });
}

async function runRoute(
  route: ResolutionRoute,
  baseRequest: Omit<RouteAttemptRequest, "attempt">,
  beforeAttempt?: DOIResolutionRequest["beforeAttempt"],
  stoppedHosts: Map<string, AttemptDiagnostic> = new Map(),
): Promise<RouteRun> {
  const attempts: AttemptEvidence[] = [];
  const webHost = baseRequest.url ? new URL(baseRequest.url).hostname : "";
  // Search 内部可能访问多个端点；遇到明确拒绝后保守停止本批 Search，不能猜测其下一个 host。
  const key = route.id === "url.web" ? webHost : "@doi.search";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await beforeAttempt?.(route.id, attempt);
    const stopped = stoppedHosts.get(key);
    if (stopped) {
      const evidence: AttemptEvidence = Object.freeze({
        routeId: route.id, attempt,
        inputIdentifiers: baseRequest.doi ? [{ type: "doi", value: baseRequest.doi }] : [],
        returnedIdentifiers: [], sourceId: webHost || route.id,
        fetchedAt: new Date().toISOString(), outcome: "fetch-failed",
        errorCode: "host-request-stopped", diagnostic: stopped,
      });
      return { candidate: null, attempts: [evidence], finalEvidence: evidence };
    }
    const result = await route.attempt({ ...baseRequest, attempt });
    let evidence = result.evidence;
    const diagnostic = evidence.diagnostic;
    const refused = !result.candidate && [401, 403, 429].includes(diagnostic?.httpStatus || 0);
    if (refused) {
      const wait = diagnostic?.retryAfterMs;
      const message = diagnostic?.httpStatus === 429
        ? `站点限流，本批次已停止继续请求${wait === undefined ? "；未提供可靠等待时间" : `；至少等待 ${Math.ceil(wait / 1000)} 秒后手动重试`}`
        : `站点拒绝访问（HTTP ${diagnostic?.httpStatus}），本批次已停止继续请求`;
      const stoppedDiagnostic = Object.freeze({ ...diagnostic!, message });
      stoppedHosts.set(key, stoppedDiagnostic);
      if (diagnostic?.requestHost) stoppedHosts.set(diagnostic.requestHost, stoppedDiagnostic);
      evidence = Object.freeze({ ...evidence, diagnostic: stoppedDiagnostic });
    }

    if (!result.candidate && result.retryable && !refused && attempt === 2) {
      evidence = Object.freeze({
        ...evidence,
        outcome: "retry-exhausted",
        errorCode: evidence.errorCode ?? "retry-exhausted",
      });
    }
    attempts.push(evidence);

    if (result.candidate) {
      return { candidate: result.candidate, attempts, finalEvidence: evidence };
    }
    if (!result.retryable || refused || attempt === 2) {
      return { candidate: null, attempts, finalEvidence: evidence };
    }
  }

  throw new Error(`路线 ${route.id} 未返回终态`);
}

function result(
  candidate: ResolutionResult["candidate"],
  attempts: readonly AttemptEvidence[],
  terminalOutcome: ResolutionResult["terminalOutcome"],
  message?: string,
): ResolutionResult {
  return freezeResult({ candidate, attempts, terminalOutcome, message });
}

function webFailureBlocks(evidence: AttemptEvidence): boolean {
  return isBlockingAttemptOutcome(evidence.outcome);
}

export function createDOIFallbackResolver(
  options: DOIFallbackResolverOptions,
): DOIFallbackResolver {
  if (options.urlWebRoute.id !== "url.web") {
    throw new TypeError("urlWebRoute.id 必须是 url.web");
  }
  if (options.doiSearchRoute.id !== "doi.search") {
    throw new TypeError("doiSearchRoute.id 必须是 doi.search");
  }
  // 一个 resolver 对应一次批次预检；新批次重新评估站点，不持久化拒绝状态。
  const stoppedHosts = new Map<string, AttemptDiagnostic>();

  async function resolve(request: DOIResolutionRequest, doiOnly: boolean): Promise<ResolutionResult> {
      const url = normalizeHTTPURL(request.url);
      const doi = normalizeDOI(request.doi);
      const attempts: AttemptEvidence[] = [];

      if (!url && !doi) {
        return result(null, attempts, "not-applicable", "条目没有有效 URL 或 DOI");
      }

      if (url && !doiOnly) {
        const web = await runRoute(options.urlWebRoute, {
          item: request.item,
          url,
          doi,
        }, request.beforeAttempt, stoppedHosts);
        attempts.push(...web.attempts);

        if (web.candidate) {
          return result(web.candidate, attempts, "candidate");
        }
        if (webFailureBlocks(web.finalEvidence)) {
          return result(null, attempts, "blocked", `Web 路线被 ${web.finalEvidence.outcome} 阻断`);
        }
        if (!isFallbackAttemptOutcome(web.finalEvidence.outcome) || !doi) {
          return result(null, attempts, "no-safe-candidate", web.finalEvidence.diagnostic?.message || "Web 路线没有安全候选，且不能进入 DOI Search");
        }
      }

      if (!doi) {
        return result(null, attempts, "no-safe-candidate", "没有有效 DOI，不能进入 DOI Search");
      }

      const search = await runRoute(options.doiSearchRoute, {
        item: request.item,
        url,
        doi,
      }, request.beforeAttempt, stoppedHosts);
      attempts.push(...search.attempts);

      if (search.candidate) {
        return result(search.candidate, attempts, "candidate");
      }
      if (isBlockingAttemptOutcome(search.finalEvidence.outcome)) {
        return result(null, attempts, "blocked", `DOI Search 被 ${search.finalEvidence.outcome} 阻断`);
      }
      return result(null, attempts, "no-safe-candidate", search.finalEvidence.diagnostic?.message || "DOI Search 没有唯一且身份安全的候选");
  }

  return Object.freeze({
    resolve: (request: DOIResolutionRequest) => resolve(request, false),
    resolveDOI: (request: DOIResolutionRequest) => resolve(request, true),
  });
}

export async function resolveDOIFallback(
  request: DOIResolutionRequest,
  options: DOIFallbackResolverOptions,
): Promise<ResolutionResult> {
  return createDOIFallbackResolver(options).resolve(request);
}
