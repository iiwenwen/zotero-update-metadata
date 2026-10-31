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
    let evidence = Object.freeze({ ...result.evidence, retryable: !result.candidate && result.retryable });
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
  const messages: Partial<Record<AttemptOutcome, readonly [string, string]>> = {
    "identity-evidence-missing": ["来源信息不足，无法确认是否为同一条目。条目未更新。请核对来源网址及条目标识符。", "The source information is not sufficient to confirm the item identity. Nothing was updated. Review the source URL and item identifiers."],
    "identifier-conflict": ["来源标识符与当前条目不一致。条目未更新。请核对 DOI、ISBN 或来源网址。", "The source identifier does not match the current item. Nothing was updated. Review the DOI, ISBN, or source URL."],
    "item-type-conflict": ["来源条目类型与当前条目不一致。条目未更新。", "The source item type does not match the current item. Nothing was updated."],
    "version-ambiguous": ["无法确认来源版本。条目未更新。请核对条目版本与来源。", "The source version could not be confirmed. Nothing was updated. Review the item version and source."],
    "multiple-results": ["来源返回多个结果，无法确定对应条目。条目未更新。", "The source returned multiple results. The matching item could not be identified. Nothing was updated."],
    "invalid-response": ["无法识别来源信息。条目未更新。请核对来源。", "The source information could not be read. Nothing was updated. Review the source."],
  };
  const message = messages[outcome] || ["无法确认来源与当前条目匹配。条目未更新。请核对来源。", "The source could not be matched to the current item. Nothing was updated. Review the source."];
  return message[english ? 1 : 0];
}

function acquisitionMessage(evidence: AttemptEvidence, english: boolean): string {
  const say = (zh: string, en: string) => english ? en : zh;
  const diagnostic = evidence.diagnostic;
  const doiSearch = evidence.routeId === "doi.search";
  if (!doiSearch && diagnostic?.stage === "translator-run"
    && (!diagnostic.httpStatus || diagnostic.httpStatus < 400)
    && /No title specified for item/i.test(diagnostic.message)) {
    return say("已读取来源网页，但未获取到标题。条目未更新。", "The source page was read, but no title was retrieved. Nothing was updated.");
  }
  if (evidence.errorCode === "host-request-stopped") {
    return doiSearch
      ? say("本次已停止 DOI 查找。本条目未发起 DOI 请求，也未更新。", "Further DOI requests in this update have stopped. No DOI request was sent for this item. Nothing was updated.")
      : say("本次已停止向此来源发送请求。本条目未获取新信息，也未更新。", "Further requests to this source have stopped. No request was sent for this item. Nothing was updated.");
  }
  if (diagnostic?.httpStatus === 429) {
    const wait = diagnostic.retryAfterMs;
    const source = doiSearch ? say("DOI 服务", "The DOI service") : say("来源", "The source");
    return wait === undefined
      ? say(`${source}限制了请求。条目未更新。请稍后重新查找。`, `${source} limited requests. Nothing was updated. Try again later.`)
      : say(`${source}限制了请求。条目未更新。请至少等待 ${Math.ceil(wait / 1000)} 秒后重试。`, `${source} limited requests. Nothing was updated. Wait at least ${Math.ceil(wait / 1000)} seconds before trying again.`);
  }
  if (diagnostic?.httpStatus === 401 || diagnostic?.httpStatus === 403) {
    return doiSearch
      ? say("DOI 查找被拒绝。条目未更新。请确认访问权限。", "The DOI request was denied. Nothing was updated. Review your access permissions.")
      : say("来源拒绝访问。条目未更新。请确认访问权限。", "The source denied access. Nothing was updated. Review your access permissions.");
  }
  if (evidence.outcome === "unsupported") {
    // 仅明确的缺转换器证据才能说明缺转换器；不能从unsupported枚举猜原因。
    if (evidence.errorCode === "translator-missing") return doiSearch
      ? say("没有可用的 DOI 转换器。条目未更新。", "No DOI translator is available. Nothing was updated.")
      : say("此网址没有可用的转换器。条目未更新。", "No translator is available for this URL. Nothing was updated.");
    return say("不支持此来源。条目未更新。", "This source is not supported. Nothing was updated.");
  }
  if (evidence.outcome === "no-result") return say("来源未返回可用信息。条目未更新。请核对网址或 DOI。", "The source returned no usable information. Nothing was updated. Review the URL or DOI.");
  if (evidence.retryable === true || evidence.outcome === "retry-exhausted") return say("无法连接来源。条目未更新。请核对网络连接后重试。", "The source could not be reached. Nothing was updated. Review the network connection before trying again.");
  return say("无法获取来源信息。条目未更新。请核对来源。", "Source information could not be retrieved. Nothing was updated. Review the source.");
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
