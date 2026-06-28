import { getPref, setPref } from "../utils/prefs";

export type AttachmentSaveStrategy = "none" | "missing" | "always";

export function isAttachmentSaveStrategy(
  value: unknown,
): value is AttachmentSaveStrategy {
  return value === "missing" || value === "always" || value === "none";
}

export function normalizeAttachmentSaveStrategy(
  value: unknown,
): AttachmentSaveStrategy {
  return isAttachmentSaveStrategy(value) ? value : "none";
}

export function getConfiguredAttachmentSaveStrategy(): AttachmentSaveStrategy {
  const strategy = getPref("attachmentSaveStrategy");
  if (isAttachmentSaveStrategy(strategy)) {
    return strategy;
  }

  const legacySaveAttachments = getPref("saveAttachments");
  return legacySaveAttachments === false || legacySaveAttachments === "false"
    ? "none"
    : "missing";
}

export function getAttachmentSaveStrategy(
  saveAttachments?: boolean,
): AttachmentSaveStrategy {
  return saveAttachments === false
    ? "none"
    : getConfiguredAttachmentSaveStrategy();
}

export function setConfiguredAttachmentSaveStrategy(
  value: unknown,
): AttachmentSaveStrategy {
  const strategy = normalizeAttachmentSaveStrategy(value);
  setPref("attachmentSaveStrategy", strategy);
  setPref("saveAttachments", strategy !== "none");
  return strategy;
}
