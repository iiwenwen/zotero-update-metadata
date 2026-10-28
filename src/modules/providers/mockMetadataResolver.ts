import type {
  CandidateCreator,
  CandidateEnvelope,
  CandidateField,
  SourceIdentifier,
  SourceRouteId,
} from "../update/contracts";
import type {
  AttemptEvidence,
  ResolutionResult,
} from "../update/resolution";
import {
  createCandidateDigest,
  normalizeDOI,
  normalizeHTTPURL,
} from "../update/resolution";
import type {
  DOIFallbackResolver,
  DOIResolutionRequest,
} from "../update/doiFallbackResolver";
import { createLocalIdentityEvidence } from "../update/identityReview";

export const MOCK_METADATA_SCENARIOS = Object.freeze([
  "success",
  "rich-success",
  "no-result",
  "http-403",
  "identifier-conflict",
  "item-type-conflict",
  "version-ambiguous",
  "identity-review",
] as const);

export type MockMetadataScenario = typeof MOCK_METADATA_SCENARIOS[number];

const MOCK_SCENARIO_PATTERN = /(?:^|\n)\s*ZMTA-MOCK\s*:\s*([a-z0-9-]+)/i;
const MOCK_TRANSLATOR = Object.freeze({
  id: "zmta-mock-translator",
  label: "ZMTA Mock（离线）",
  attribution: "selected" as const,
});

function scenario(request: DOIResolutionRequest): MockMetadataScenario {
  const extra = typeof request.item.fields.extra === "string" ? request.item.fields.extra : "";
  const requested = MOCK_SCENARIO_PATTERN.exec(extra)?.[1]?.toLowerCase();
  return MOCK_METADATA_SCENARIOS.includes(requested as MockMetadataScenario)
    ? requested as MockMetadataScenario
    : "success";
}

function routeInput(
  request: DOIResolutionRequest,
  doiOnly: boolean,
): { routeId: SourceRouteId; sourceURL: string; identifiers: SourceIdentifier[] } | null {
  const doi = normalizeDOI(request.doi ?? request.item.fields.DOI);
  const url = normalizeHTTPURL(request.url ?? request.item.fields.url);
  if (doiOnly) {
    return doi ? {
      routeId: "doi.search",
      sourceURL: `https://doi.org/${doi}`,
      identifiers: [{ type: "doi", value: doi }],
    } : null;
  }
  if (url) {
    return {
      routeId: "url.web",
      sourceURL: url,
      identifiers: [
        { type: "url", value: url },
        ...(doi ? [{ type: "doi", value: doi }] : []),
      ],
    };
  }
  return doi ? {
    routeId: "doi.search",
    sourceURL: `https://doi.org/${doi}`,
    identifiers: [{ type: "doi", value: doi }],
  } : null;
}

function candidateFields(request: DOIResolutionRequest): CandidateField[] {
  const values: Record<string, unknown> = {
    title: request.item.fields.title ?? request.item.title,
    abstractNote: "[ZMTA Mock] 这是离线测试候选，不来自真实上游。",
    publisher: "ZMTA Mock 出版社",
    date: "2026",
    language: "zh-CN",
    url: request.item.fields.url,
    DOI: request.item.fields.DOI,
    ISBN: request.item.fields.ISBN,
  };
  return Object.entries(values).flatMap(([field, value]) => (
    value === undefined || value === null || value === "" ? [] : [{ field, value }]
  ));
}

function candidateCreators(request: DOIResolutionRequest, rich: boolean): readonly CandidateCreator[] | undefined {
  if (!rich || request.item.itemType !== "book") return undefined;
  return Object.freeze([
    Object.freeze({ creatorType: "author", firstName: "三", lastName: "张" }),
    Object.freeze({ creatorType: "author", name: "中国图书研究会" }),
    Object.freeze({ creatorType: "editor", firstName: "四", lastName: "李" }),
    Object.freeze({ creatorType: "translator", firstName: "三", lastName: "张" }),
  ]);
}

function attempt(
  routeId: SourceRouteId,
  attemptNumber: number,
  identifiers: readonly SourceIdentifier[],
  outcome: AttemptEvidence["outcome"],
  options: Partial<AttemptEvidence> = {},
): AttemptEvidence {
  return Object.freeze({
    routeId,
    attempt: attemptNumber,
    inputIdentifiers: Object.freeze([...identifiers]),
    returnedIdentifiers: Object.freeze([...identifiers]),
    translator: MOCK_TRANSLATOR,
    sourceId: "mock.local",
    fetchedAt: new Date().toISOString(),
    outcome,
    ...options,
  });
}

function failureResult(
  routeId: SourceRouteId,
  identifiers: readonly SourceIdentifier[],
  selectedScenario: MockMetadataScenario,
): ResolutionResult | null {
  const blocked = new Set<MockMetadataScenario>([
    "identifier-conflict",
    "item-type-conflict",
    "version-ambiguous",
  ]);
  if (selectedScenario === "no-result") {
    return Object.freeze({
      candidate: null,
      attempts: Object.freeze([attempt(routeId, 1, identifiers, "no-result", { errorCode: "mock-no-result" })]),
      terminalOutcome: "no-safe-candidate",
      message: "Mock 场景：Translator 没有返回结果",
    });
  }
  if (selectedScenario === "http-403") {
    return Object.freeze({
      candidate: null,
      attempts: Object.freeze([
        attempt(routeId, 1, identifiers, "fetch-failed", {
          errorCode: "mock-http-403",
          diagnostic: { stage: "document-fetch", message: "Mock 场景：上游拒绝请求", httpStatus: 403 },
        }),
      ]),
      terminalOutcome: "no-safe-candidate",
      message: "Mock 场景：HTTP 403，站点拒绝访问，不自动重试",
    });
  }
  if (blocked.has(selectedScenario)) {
    return Object.freeze({
      candidate: null,
      attempts: Object.freeze([attempt(routeId, 1, identifiers, selectedScenario, {
        errorCode: `mock-${selectedScenario}`,
      })]),
      terminalOutcome: "blocked",
      message: `Mock 场景：${selectedScenario}`,
    });
  }
  return null;
}

async function resolveMock(
  request: DOIResolutionRequest,
  doiOnly: boolean,
): Promise<ResolutionResult> {
  const input = routeInput(request, doiOnly);
  if (!input) {
    return Object.freeze({
      candidate: null,
      attempts: Object.freeze([]),
      terminalOutcome: "not-applicable",
      message: doiOnly ? "Mock：条目没有有效 DOI" : "Mock：条目没有有效 URL 或 DOI",
    });
  }

  const selectedScenario = scenario(request);
  await request.beforeAttempt?.(input.routeId, 1);
  if (selectedScenario === "identity-review" && !normalizeHTTPURL(request.item.fields.url)) {
    return Object.freeze({
      candidate: null,
      attempts: Object.freeze([attempt(input.routeId, 1, input.identifiers, "identity-evidence-missing", { errorCode: "mock-identity-evidence-missing" })]),
      terminalOutcome: "blocked",
      message: "Mock 身份确认场景需要条目已有有效 URL",
    });
  }
  const failed = failureResult(input.routeId, input.identifiers, selectedScenario);
  if (failed) return failed;

  const rich = selectedScenario === "rich-success";
  const creators = candidateCreators(request, rich);
  const candidate: CandidateEnvelope = Object.freeze({
    providerId: "zmta-mock",
    item: Object.freeze({
      itemID: request.item.itemID,
      itemKey: request.item.itemKey,
      libraryID: request.item.libraryID,
      itemType: request.item.itemType,
      title: request.item.title,
    }),
    evidence: Object.freeze({
      providerId: "zmta-mock",
      sourceURL: input.sourceURL,
      identifiers: Object.freeze([...input.identifiers]),
      fetchedAt: new Date().toISOString(),
      routeId: input.routeId,
      sourceId: "mock.local",
      translator: MOCK_TRANSLATOR,
    }),
    itemType: request.item.itemType,
    fields: Object.freeze(candidateFields(request)),
    ...(creators ? { creators } : {}),
    attachments: Object.freeze(rich ? [{
      operationId: "mock-attachment",
      url: "https://example.test/zmta/mock.pdf",
      title: "ZMTA Mock PDF",
      mimeType: "application/pdf",
    }] : []),
    notes: Object.freeze(rich ? [{
      operationId: "mock-note",
      content: "<p>ZMTA Mock 离线测试 Note</p>",
    }] : []),
    ...(selectedScenario === "identity-review" ? {
      identityReview: Object.freeze({
        required: true as const,
        matchedFields: Object.freeze(["title", "url"] as const),
        summary: "Mock 场景：系统仅匹配标题和 URL，请确认是同一对象",
        localEvidence: createLocalIdentityEvidence({ ...request.item.fields, title: request.item.fields.title ?? request.item.title }, ["title", "url"]),
      }),
    } : {}),
  });
  const evidence = attempt(input.routeId, 1, input.identifiers, "candidate", {
    candidateDigest: createCandidateDigest(candidate),
  });
  return Object.freeze({
    candidate,
    attempts: Object.freeze([evidence]),
    terminalOutcome: "candidate",
    message: `Mock 场景：${selectedScenario}`,
  });
}

export function createMockMetadataResolver(): DOIFallbackResolver {
  return Object.freeze({
    resolve: (request) => resolveMock(request, false),
    resolveDOI: (request) => resolveMock(request, true),
  });
}
