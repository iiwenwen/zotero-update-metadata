import type { ProviderItemSnapshot } from "./provider";
import {
  isBlockingAttemptOutcome,
  isFallbackAttemptOutcome,
  normalizeDOI,
  normalizeHTTPURL,
  type AttemptEvidence,
  type AttemptDiagnostic,
  type AttemptOutcome,
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
  readonly locale?: string;
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
        ? `访问过于频繁，网站暂时不接受请求，本次更新已停止继续请求${wait === undefined ? "；未提供可靠等待时间" : `；至少等待 ${Math.ceil(wait / 1000)} 秒后手动重试`}`
        : `站点拒绝访问（HTTP ${diagnostic?.httpStatus}），本次更新已停止继续请求`;
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

/** 不把内部枚举当作用户可操作的原因；详细依据仍留在 attempts。 */
function blockedMessage(outcome: AttemptOutcome, english: boolean): string {
  if (english) {
    switch (outcome) {
      case "identity-evidence-missing": return "The source does not provide enough information to confirm this is the same item. Nothing was updated. Check the item's identifiers and source.";
      case "identifier-conflict": return "The source identifier differs from the current item. Nothing was updated. Check the item's identifiers and source.";
      case "item-type-conflict": return "The source item type differs from the current item. Nothing was updated. Check the item and its source.";
      case "version-ambiguous": return "The source version cannot be confirmed as the same as the current item. Nothing was updated. Check the item and its source.";
      case "multiple-results": return "The source returned multiple results, so the matching item could not be determined. Nothing was updated. Check the item and its source.";
      case "invalid-response": return "The source returned incomplete or unrecognizable information. Nothing was updated. Check the source or try again later.";
      default: return "The source could not be safely matched to the current item. Nothing was updated. Check the item and its source.";
    }
  }
  switch (outcome) {
    case "identity-evidence-missing": return "来源信息不足，无法确认是否为同一条目；未进行更新。请核对条目的 DOI、ISBN 等编号和来源网址。";
    case "identifier-conflict": return "来源返回的标识符与当前条目不一致；未进行更新。请核对条目的 DOI、ISBN 等编号和来源网址。";
    case "item-type-conflict": return "来源返回的条目类型与当前条目不一致；未进行更新。请核对条目及其来源。";
    case "version-ambiguous": return "无法确认来源与当前条目是否为同一版本；未进行更新。请核对条目及其来源。";
    case "multiple-results": return "来源返回多个结果，无法确定对应的条目；未进行更新。请核对条目及其来源。";
    case "invalid-response": return "来源返回的信息不完整或无法识别；未进行更新。请稍后重试或核对来源。";
    default: return "无法安全确认来源与当前条目的一致性；未进行更新。请核对条目及其来源。";
  }
}

function acquisitionMessage(evidence: AttemptEvidence, english: boolean): string {
  const diagnostic = evidence.diagnostic;
  const doiSearch = evidence.routeId === "doi.search";
  if (!doiSearch && diagnostic?.stage === "translator-run"
    && (!diagnostic.httpStatus || diagnostic.httpStatus < 400)
    && /No title specified for item/i.test(diagnostic.message)) {
    return english
      ? "The source page was fetched, but its title could not be read. Nothing was updated. Try another source or retry later."
      : "已读取来源网页，但没有识别出标题；原条目信息已保留。请更换来源或稍后重试。";
  }
  if (evidence.errorCode === "host-request-stopped") {
    return english
      ? doiSearch
        ? "An earlier request was denied or limited, so later DOI searches in this batch have stopped. This item's DOI search was not sent; it was not updated."
        : "An earlier request to this source was denied or limited, so further requests to it in this batch have stopped. No request to this source was made for this item; it was not updated."
      : doiSearch
        ? "此前访问被拒绝，或请求过于频繁，本次更新后续 DOI 查询已停止。本条目未发起 DOI 查询，也未更新。"
        : "此前对此来源的访问被拒绝，或请求过于频繁，本次更新对该来源的后续请求已停止。本条目未向该来源发起请求，也未更新。";
  }
  if (english && doiSearch && diagnostic?.httpStatus === 429) {
    const wait = diagnostic.retryAfterMs;
    return wait === undefined
      ? "The DOI search was limited; later DOI searches in this batch have stopped. This item was not updated. No reliable wait time was provided; try again later."
      : `The DOI search was limited; later DOI searches in this batch have stopped. This item was not updated. Wait at least ${Math.ceil(wait / 1000)} seconds before retrying.`;
  }
  if (english && doiSearch && (diagnostic?.httpStatus === 401 || diagnostic?.httpStatus === 403)) {
    return "The DOI search was denied; later DOI searches in this batch have stopped. This item was not updated. Check your access permissions.";
  }
  if (!english && doiSearch && diagnostic?.httpStatus === 429) {
    const wait = diagnostic.retryAfterMs;
    return wait === undefined
      ? "DOI 查询过于频繁，服务暂时不接受请求，本次更新后续 DOI 查询已停止，本条目未更新；未提供可靠等待时间，请稍后手动重试。"
      : `DOI 查询过于频繁，服务暂时不接受请求，本次更新后续 DOI 查询已停止，本条目未更新。请至少等待 ${Math.ceil(wait / 1000)} 秒后手动重试。`;
  }
  if (!english && doiSearch && (diagnostic?.httpStatus === 401 || diagnostic?.httpStatus === 403)) {
    return "DOI 查询被拒绝，本次更新后续 DOI 查询已停止，本条目未更新。请确认是否有访问权限。";
  }
  if (english) {
    if (diagnostic?.httpStatus === 429) {
      const wait = diagnostic.retryAfterMs;
      return wait === undefined
        ? "The source limited access, so further requests to it in this batch have stopped. This item was not updated. No reliable wait time was provided; try again later."
        : `The source limited access, so further requests to it in this batch have stopped. This item was not updated. Wait at least ${Math.ceil(wait / 1000)} seconds before retrying.`;
    }
    if (diagnostic?.httpStatus === 401 || diagnostic?.httpStatus === 403) return "The source denied access, so further requests to it in this batch have stopped. This item was not updated. Check your access permissions.";
    if (evidence.outcome === "unsupported") return "This source is not currently supported. Nothing was updated. Check the source address or the item's DOI.";
    if (evidence.outcome === "no-result") return "The source returned no usable metadata. Nothing was updated. Check the source address or the item's DOI.";
    return "Could not retrieve source information. Nothing was updated. Check your network and source address, then try again.";
  }
  if (diagnostic?.httpStatus === 429) {
    const wait = diagnostic.retryAfterMs;
    return wait === undefined
      ? "来源限制了访问，已停止本次更新对该来源的请求，本条目未更新；未提供可靠等待时间，请稍后手动重试。"
      : `来源限制了访问，已停止本次更新对该来源的请求，本条目未更新。请至少等待 ${Math.ceil(wait / 1000)} 秒后手动重试。`;
  }
  if (diagnostic?.httpStatus === 401 || diagnostic?.httpStatus === 403) {
    return "来源拒绝访问，已停止本次更新对该来源的请求，本条目未更新。请确认是否有访问权限。";
  }
  if (evidence.outcome === "unsupported") return "当前来源暂不支持获取条目信息；未进行更新。请检查来源地址或条目的 DOI。";
  if (evidence.outcome === "no-result") return "来源没有返回可用的条目信息；未进行更新。请检查来源地址或条目的 DOI。";
  return "无法获取来源信息；未进行更新。请检查网络及来源地址后重试。";
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
  const english = Boolean(options.locale && !options.locale.toLowerCase().startsWith("zh"));

  async function resolve(request: DOIResolutionRequest, doiOnly: boolean): Promise<ResolutionResult> {
      const url = normalizeHTTPURL(request.url);
      const doi = normalizeDOI(request.doi);
      const attempts: AttemptEvidence[] = [];

      if (!url && !doi) {
        return result(null, attempts, "not-applicable", english
          ? "This item has no valid URL or DOI. Add one before reviewing updates."
          : "条目没有有效的网址或 DOI。请先填写，再审核更新。");
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
          return result(null, attempts, "blocked", blockedMessage(web.finalEvidence.outcome, english));
        }
        if (!isFallbackAttemptOutcome(web.finalEvidence.outcome) || !doi) {
          return result(null, attempts, "no-safe-candidate", acquisitionMessage(web.finalEvidence, english));
        }
      }

      if (!doi) {
        return result(null, attempts, "no-safe-candidate", english
          ? "This item has no valid DOI. Add one before retrieving metadata using DOI."
          : "条目没有有效 DOI。请先填写，再使用 DOI 获取条目信息。");
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
        return result(null, attempts, "blocked", blockedMessage(search.finalEvidence.outcome, english));
      }
      return result(null, attempts, "no-safe-candidate", acquisitionMessage(search.finalEvidence, english));
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
