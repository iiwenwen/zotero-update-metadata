import type { CandidateCreator, CandidateIdentityReview, IdentityMatchField, LocalIdentityEvidence } from "./contracts";
import { normalizeHTTPURL } from "./resolution";

export function comparableText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "") || null
    : null;
}

export function identityYear(value: unknown): string | null {
  return /(?:^|\D)((?:1[5-9]|20)\d{2})(?:\D|$)/.exec(String(value ?? ""))?.[1] || null;
}

export function creatorNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const creator = entry as Record<string, unknown>;
    const name = creator.name ?? [creator.firstName, creator.lastName].filter(Boolean).join(" ") ?? creator.lastName;
    const normalized = comparableText(name);
    return normalized ? [normalized] : [];
  }))].sort();
}

function sourceField(field: IdentityMatchField): string {
  return field === "creator" ? "creators" : field === "year" ? "date" : field;
}

function evidenceValue(field: IdentityMatchField, value: unknown): string | readonly string[] | null {
  if (field === "creator") return creatorNames(value);
  if (field === "year") return identityYear(value);
  if (field === "url") return normalizeHTTPURL(value);
  return comparableText(value);
}

export function createLocalIdentityEvidence(
  fields: Readonly<Record<string, unknown>>,
  matchedFields: readonly IdentityMatchField[],
): readonly LocalIdentityEvidence[] {
  return Object.freeze(matchedFields.map((field) => {
    const key = field === "publisher" ? fields.publisher == null ? "publicationTitle" : "publisher" : sourceField(field);
    const value = evidenceValue(field, fields[key]);
    if (value === null || (Array.isArray(value) && value.length === 0)) throw new Error("身份匹配依据缺失");
    return Object.freeze({ field, value: Array.isArray(value) ? Object.freeze(value) : value,
      ...(field === "publisher" ? { sourceField: key as "publisher" | "publicationTitle" } : {}),
    });
  }));
}

/** 原确认绑定原依据；外部改变后不自动改用另一组匹配重新放行。 */
export function assertLocalIdentityEvidence(
  review: CandidateIdentityReview,
  current: Readonly<Record<string, unknown>>,
  appliedFields: ReadonlyMap<string, unknown>,
  appliedCreators?: readonly CandidateCreator[],
): void {
  const allowed = new Set(["title", "creator", "year", "publisher", "url"]);
  if (!Array.isArray(review.matchedFields) || review.matchedFields.length < 2
    || !review.matchedFields.includes("title") || new Set(review.matchedFields).size !== review.matchedFields.length
    || !Array.isArray(review.localEvidence) || review.localEvidence.length !== review.matchedFields.length) {
    throw new Error("组合身份确认缺少有效的本地依据，请重新预检并确认");
  }
  for (const [index, field] of review.matchedFields.entries()) {
    const entry = review.localEvidence[index];
    if (!allowed.has(field) || !entry || entry.field !== field
      || (field === "creator"
        ? !Array.isArray(entry.value) || entry.value.length === 0 || entry.value.some((value) => typeof value !== "string" || !value)
        : typeof entry.value !== "string" || !entry.value)
      || (field === "publisher" && entry.sourceField !== "publisher" && entry.sourceField !== "publicationTitle")) {
      throw new Error("组合身份确认的本地依据无效，请重新预检并确认");
    }
    if (field !== "publisher" && entry.sourceField !== undefined) {
      throw new Error("组合身份确认的依赖字段无效，请重新预检并确认");
    }
    const key = entry.sourceField || sourceField(field);
    const expected = field === "creator" && appliedCreators !== undefined
      ? creatorNames(appliedCreators)
      : appliedFields.has(key) ? evidenceValue(field, appliedFields.get(key)) : entry.value;
    if (JSON.stringify(evidenceValue(field, current[key])) !== JSON.stringify(expected)) {
      throw new Error("审核后身份匹配依据已变化，请重新预检并确认");
    }
  }
}
