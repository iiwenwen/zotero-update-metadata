import { localized } from "../utils/locale";

// 审核与更新记录共用宿主字段名称；内部key只用于数据，不作用户文案。
const FIELD_LABELS: Record<string, readonly [string, string]> = {
  title: ["标题", "Title"], shortTitle: ["短标题", "Short Title"], abstractNote: ["摘要", "Abstract"], date: ["日期", "Date"],
  publisher: ["出版社", "Publisher"], publicationTitle: ["刊物名称", "Publication"], volume: ["卷", "Volume"], issue: ["期", "Issue"],
  pages: ["页码", "Pages"], edition: ["版次", "Edition"], language: ["语言", "Language"], ISBN: ["ISBN", "ISBN"], ISSN: ["ISSN", "ISSN"],
  DOI: ["DOI", "DOI"], url: ["网址", "URL"], accessDate: ["访问时间", "Accessed"], conferenceName: ["会议名称", "Conference Name"],
  libraryCatalog: ["文库编目", "Library Catalog"], place: ["地点", "Place"], extra: ["其他", "Extra"], rights: ["版权", "Rights"],
  proceedingsTitle: ["论文集标题", "Proceedings Title"], series: ["丛书", "Series"], seriesTitle: ["丛书标题", "Series Title"],
  seriesNumber: ["丛书编号", "Series Number"], numPages: ["总页数", "Number of Pages"], numberOfVolumes: ["总卷数", "Number of Volumes"],
  journalAbbreviation: ["刊名简称", "Journal Abbreviation"], archive: ["档案馆", "Archive"], archiveLocation: ["馆藏位置", "Archive Location"],
  callNumber: ["索书号", "Call Number"], itemType: ["条目类型", "Item Type"], dateAdded: ["添加日期", "Date Added"], dateModified: ["修改日期", "Date Modified"],
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
  const pair = FIELD_LABELS[field];
  return pair ? localized(pair[0], pair[1]) : localized("其他信息", "Other information");
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
