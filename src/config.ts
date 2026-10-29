import manifest from "../addon/manifest.json";

// 插件身份与安装清单一致，供所有宿主注册入口复用。
export const PLUGIN_ID = manifest.applications.zotero.id;
