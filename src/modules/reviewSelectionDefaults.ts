import { getPref } from "../utils/prefs";

export interface ReviewSelectionDefaults {
  readonly attachments: boolean;
  readonly notes: boolean;
}

function readDefault(key: string): boolean {
  try {
    return getPref(key) === true;
  } catch {
    return false;
  }
}

/** 每次开窗取得独立快照；未设置、非法值和读取失败都不预选新增内容。 */
export function getReviewSelectionDefaults(): Readonly<ReviewSelectionDefaults> {
  return Object.freeze({
    attachments: readDefault("defaultSelectAttachments"),
    notes: readDefault("defaultSelectNotes"),
  });
}
