import type {
  CandidateEnvelope,
  SourceIdentifier,
  SourceRouteId,
  TranslatorEvidence,
} from "./contracts";
import type { ProviderItemSnapshot } from "./provider";

export const ROUTE_IDS = Object.freeze(["url.web", "doi.search"] as const);
export type RouteId = SourceRouteId;

export const ATTEMPT_OUTCOMES = Object.freeze([
  "candidate",
  "unsupported",
  "no-result",
  "multiple-results",
  "fetch-failed",
  "retry-exhausted",
  "identity-evidence-missing",
  "identifier-conflict",
  "item-type-conflict",
  "version-ambiguous",
  "invalid-response",
] as const);

export type AttemptOutcome = typeof ATTEMPT_OUTCOMES[number];
export type AttemptDisposition = "candidate" | "acquisition-failure" | "candidate-rejected";

export type AttemptStage =
  | "document-fetch"
  | "translator-detect"
  | "translator-run"
  | "candidate-convert"
  | "route";

export interface AttemptDiagnostic {
  readonly stage: AttemptStage;
  readonly message: string;
  readonly errorName?: string;
  readonly httpStatus?: number;
  /** 上游明确返回的等待时间；只用于本次预检提示，不进入 journal。 */
  readonly retryAfterMs?: number;
  readonly requestHost?: string;
}

function httpDiagnostic(cause: unknown): Pick<AttemptDiagnostic, "httpStatus" | "retryAfterMs" | "requestHost"> {
  const seen = new Set<unknown>();
  let current = cause;
  for (let depth = 0; depth < 6 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    const record = current as Record<string, any>;
    const xhr = record.xmlhttp || record.xhr || record.response;
    const diagnostic = record.diagnostic;
    const status = record.status ?? record.statusCode ?? record.responseStatus ?? xhr?.status ?? diagnostic?.httpStatus;
    const httpStatus = /^\d{3}$/.test(String(status)) ? Number(status) : undefined;
    if (httpStatus) {
      let header: unknown = record.retryAfter;
      try {
        header ??= xhr?.getResponseHeader?.("Retry-After")
          ?? record.headers?.get?.("Retry-After")
          ?? record.headers?.["retry-after"] ?? record.headers?.["Retry-After"];
      } catch { /* 跨域响应可能不允许读取头；无可靠值就停止。 */ }
      const value = typeof header === "string" || typeof header === "number" ? String(header).trim() : "";
      const delay = /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - Date.now() : NaN;
      const retryAfterMs = diagnostic?.retryAfterMs
        ?? (Number.isFinite(delay) && delay >= 0 && delay <= Number.MAX_SAFE_INTEGER ? delay : undefined);
      let requestHost: string | undefined = diagnostic?.requestHost;
      try {
        requestHost ||= new URL(xhr?.responseURL || record.responseURL || record.url).hostname;
      } catch { /* 未知的 Search 内部 URL 不伪造为 doi.org。 */ }
      return { httpStatus, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(requestHost ? { requestHost } : {}) };
    }
    current = record.cause;
  }
  return {};
}

export function createAttemptDiagnostic(
  stage: AttemptStage,
  message: string,
  cause?: unknown,
): AttemptDiagnostic {
  const record = cause && typeof cause === "object" && !Array.isArray(cause)
    ? cause as Record<string, unknown>
    : null;
  const causeMessage = cause instanceof Error
    ? cause.message
    : typeof record?.message === "string" ? record.message : null;
  const errorName = cause instanceof Error
    ? cause.name
    : typeof record?.name === "string" ? record.name : undefined;
  return Object.freeze({
    stage,
    message: causeMessage && causeMessage !== message ? `${message}：${causeMessage}` : message,
    ...(errorName ? { errorName } : {}),
    ...httpDiagnostic(cause),
  });
}

export type TerminalOutcome =
  | "candidate"
  | "blocked"
  | "no-safe-candidate"
  | "not-applicable";

export interface AttemptEvidence {
  readonly routeId: RouteId;
  readonly attempt: number;
  readonly inputIdentifiers: readonly SourceIdentifier[];
  readonly returnedIdentifiers: readonly SourceIdentifier[];
  readonly translator?: TranslatorEvidence;
  readonly sourceId: string;
  readonly fetchedAt: string;
  readonly outcome: AttemptOutcome;
  readonly candidateDigest?: string;
  readonly errorCode?: string;
  /** 本次路线是否因临时故障结束，供审核页判定手动恢复；不进入写入记录。 */
  readonly retryable?: boolean;
  /** 仅保留本次预检所需的安全诊断，不进入 applied journal。 */
  readonly diagnostic?: AttemptDiagnostic;
}

export interface ResolutionResult {
  readonly candidate: CandidateEnvelope | null;
  readonly attempts: readonly AttemptEvidence[];
  readonly terminalOutcome: TerminalOutcome;
  readonly message?: string;
}

export interface RouteAttemptRequest {
  readonly item: ProviderItemSnapshot;
  readonly url: string | null;
  readonly doi: string | null;
  readonly attempt: number;
}

export interface RouteAttemptSuccess {
  readonly candidate: CandidateEnvelope;
  readonly evidence: AttemptEvidence;
  readonly retryable?: false;
}

export interface RouteAttemptFailure {
  readonly candidate: null;
  readonly evidence: AttemptEvidence;
  readonly retryable: boolean;
}

export type RouteAttemptResult = RouteAttemptSuccess | RouteAttemptFailure;

export interface ResolutionRoute {
  readonly id: RouteId;
  attempt(request: RouteAttemptRequest): Promise<RouteAttemptResult>;
}

const FALLBACK_OUTCOMES = new Set<AttemptOutcome>([
  "unsupported",
  "no-result",
  "fetch-failed",
  "retry-exhausted",
]);

const BLOCKING_OUTCOMES = new Set<AttemptOutcome>([
  "multiple-results",
  "identity-evidence-missing",
  "identifier-conflict",
  "item-type-conflict",
  "version-ambiguous",
  "invalid-response",
]);

export function classifyAttemptOutcome(outcome: AttemptOutcome): AttemptDisposition {
  if (outcome === "candidate") return "candidate";
  if (FALLBACK_OUTCOMES.has(outcome)) return "acquisition-failure";
  if (BLOCKING_OUTCOMES.has(outcome)) return "candidate-rejected";
  throw new TypeError(`未知路线结果：${outcome}`);
}

export function isFallbackAttemptOutcome(outcome: AttemptOutcome): boolean {
  return classifyAttemptOutcome(outcome) === "acquisition-failure";
}

export function isBlockingAttemptOutcome(outcome: AttemptOutcome): boolean {
  return classifyAttemptOutcome(outcome) === "candidate-rejected";
}

export function normalizeDOI(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized = value.trim();
  if (!normalized) return null;

  const doiURL = /^(https?):\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(normalized);
  if (doiURL) {
    try {
      const parsed = new URL(normalized);
      if (!/^(?:dx\.)?doi\.org$/i.test(parsed.hostname)) return null;
      normalized = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      return null;
    }
  } else {
    normalized = normalized.replace(/^doi\s*:\s*/i, "").trim();
  }

  if (!/^10\.\d{4,9}\/\S+$/i.test(normalized)) return null;
  if (/\s/.test(normalized)) return null;
  return normalized.toLowerCase();
}

export function normalizeHTTPURL(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createCandidateDigest(candidate: CandidateEnvelope): string {
  const payload = {
    providerId: candidate.providerId,
    item: {
      itemID: candidate.item.itemID,
      itemKey: candidate.item.itemKey,
      libraryID: candidate.item.libraryID,
    },
    evidence: {
      providerId: candidate.evidence.providerId,
      sourceURL: candidate.evidence.sourceURL,
      identifiers: candidate.evidence.identifiers,
      routeId: candidate.evidence.routeId,
      sourceId: candidate.evidence.sourceId,
      translator: candidate.evidence.translator,
    },
    itemType: candidate.itemType,
    fields: candidate.fields,
    creators: candidate.creators,
    attachments: candidate.attachments,
    notes: candidate.notes,
    identityReview: candidate.identityReview,
    localIdentifiers: candidate.localIdentifiers,
  };
  return `fnv1a:${fnv1a(JSON.stringify(canonicalize(payload)))}`;
}
