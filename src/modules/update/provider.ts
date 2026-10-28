import type {
  CandidateEnvelope,
  MetadataItemRef,
  SourceIdentifier,
} from "./contracts";

export interface ProviderItemSnapshot extends MetadataItemRef {
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ProviderCapabilities {
  readonly itemTypes: readonly string[];
  readonly identifierTypes: readonly string[];
  readonly fields: boolean;
  readonly attachments: "none" | "create-only";
  readonly notes: "none" | "create-only";
}

export interface ProviderFetchRequest {
  readonly item: ProviderItemSnapshot;
  readonly identifiers: readonly SourceIdentifier[];
}

export type ProviderErrorCode =
  | "not-applicable"
  | "identifier-missing"
  | "fetch-failed"
  | "unsupported"
  | "translator-missing"
  | "no-result"
  | "multiple-results"
  | "retry-exhausted"
  | "identity-evidence-missing"
  | "identifier-conflict"
  | "item-type-conflict"
  | "version-ambiguous"
  | "source-mismatch"
  | "invalid-response"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "ProviderError";
    if (options && "cause" in options) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export interface MetadataProvider<TSource = unknown> {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  applies(item: ProviderItemSnapshot): boolean;
  resolveIdentifiers(item: ProviderItemSnapshot): readonly SourceIdentifier[];
  fetch(request: ProviderFetchRequest): Promise<TSource>;
  transform(source: TSource, request: ProviderFetchRequest): CandidateEnvelope;
  verify(candidate: CandidateEnvelope, request: ProviderFetchRequest): Promise<void> | void;
  classifyError(error: unknown): ProviderError;
}

export async function fetchProviderCandidate<TSource>(
  provider: MetadataProvider<TSource>,
  item: ProviderItemSnapshot,
): Promise<CandidateEnvelope> {
  if (!provider.applies(item)) {
    throw new ProviderError(provider.id, "not-applicable", "来源不适用于该条目", false);
  }
  const identifiers = provider.resolveIdentifiers(item);
  if (identifiers.length === 0) {
    throw new ProviderError(provider.id, "identifier-missing", "条目缺少该来源所需标识符", false);
  }
  const request = { item, identifiers };
  try {
    const source = await provider.fetch(request);
    const candidate = provider.transform(source, request);
    await provider.verify(candidate, request);
    return candidate;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw provider.classifyError(error);
  }
}
