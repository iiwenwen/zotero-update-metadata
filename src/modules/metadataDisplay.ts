import { localized } from "../utils/locale";

// 审核与更新记录共用宿主字段名称；内部key只用于数据，不作用户文案。
const FIELD_LABELS: Record<string, string> = {
  title: "标题", shortTitle: "短标题", abstractNote: "摘要", date: "日期",
  publisher: "出版社", publicationTitle: "刊物名称", volume: "卷", issue: "期",
  pages: "页码", edition: "版次", language: "语言", ISBN: "ISBN", ISSN: "ISSN",
  DOI: "DOI", url: "网址", accessDate: "访问时间", conferenceName: "会议名称",
  libraryCatalog: "文库编目", place: "地点", extra: "其他", rights: "版权",
  proceedingsTitle: "论文集标题", series: "丛书", seriesTitle: "丛书标题",
  seriesNumber: "丛书编号", numPages: "总页数", numberOfVolumes: "总卷数",
  journalAbbreviation: "刊名简称", archive: "档案馆", archiveLocation: "馆藏位置",
  callNumber: "索书号", itemType: "条目类型", dateAdded: "添加日期", dateModified: "修改日期",
};

// 作者角色与获取方式在六个对话框里反复出现，标签只在这里定义一次。
const CREATOR_ROLE_LABELS: Record<string, readonly [string, string]> = {
  author: ["作者", "Author"],
  bookAuthor: ["原著作者", "Book Author"],
  contributor: ["贡献者", "Contributor"],
  editor: ["编辑", "Editor"],
  seriesEditor: ["丛书编辑", "Series Editor"],
  translator: ["译者", "Translator"],
  director: ["导演", "Director"],
  scriptwriter: ["编剧", "Screenwriter"],
  producer: ["制片人", "Producer"],
  performer: ["表演者", "Performer"],
  composer: ["作曲者", "Composer"],
  artist: ["艺术家", "Artist"],
  interviewer: ["采访者", "Interviewer"],
  interviewee: ["受访者", "Interviewee"],
  inventor: ["发明人", "Inventor"],
};

const ROUTE_LABELS: Record<string, readonly [string, string]> = {
  "url.web": ["网页获取", "From web page"],
  "doi.search": ["DOI 检索", "DOI lookup"],
};

const IDENTITY_FIELD_LABELS: Record<string, readonly [string, string]> = {
  creator: ["作者", "Creator"],
  year: ["年份", "Year"],
  publisher: ["出版社或刊物", "Publisher or journal"],
};

export function metadataFieldLabel(field: string): string {
  try {
    const label = Zotero.ItemFields?.getLocalizedString(field);
    if (typeof label === "string" && label.trim() && label !== field) return label;
  } catch { /* 未知字段或离线fixture使用可读后备名称 */ }
  return FIELD_LABELS[field] || localized("其他信息", "Other information");
}

export function creatorRoleLabel(creatorType: string): string {
  const pair = CREATOR_ROLE_LABELS[creatorType];
  return pair ? localized(pair[0], pair[1]) : localized("其他贡献者", "Other contributor");
}

/** 未知路线保留原 id，便于在技术详情里对照排障。 */
export function metadataRouteLabel(routeId?: string | null): string | null {
  if (!routeId) return null;
  const pair = ROUTE_LABELS[routeId];
  return pair ? localized(pair[0], pair[1]) : routeId;
}

export function identityFieldLabel(field: string): string {
  const pair = IDENTITY_FIELD_LABELS[field];
  return pair ? localized(pair[0], pair[1]) : metadataFieldLabel(field);
}

export function metadataSourceLabel(providerId?: string): string | null {
  switch (providerId) {
    case "douban": case "douban-web": return localized("豆瓣读书", "Douban Books");
    case "zotero-search": return localized("Zotero（按 DOI 查找）", "Zotero (by DOI)");
    case "zotero": return "Zotero";
    default: return null;
  }
}

/** 记录时间按使用者本地时区显示；原始时间仍留在 journal 和技术详情中。 */
export function metadataRecordTime(value?: string): string {
  if (!value) return localized("尚未结束", "Not finished");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return localized("时间未知", "Time unknown");
  return new Intl.DateTimeFormat(Zotero.locale || "zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZoneName: "short",
  }).format(date);
}
