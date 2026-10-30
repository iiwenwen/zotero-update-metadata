import manifest from "../addon/manifest.json";

// 插件身份与安装清单一致，供所有宿主注册入口复用。
export const PLUGIN_ID = manifest.applications.zotero.id;

/**
 * 应用内用户可见的产品名，与菜单、侧栏、设置面板的入口名保持同一个词。
 * 安装清单（addon/manifest.json）里的长名只在插件管理器出现，不参与此处。
 */
export const PLUGIN_NAME = Object.freeze({ zh: "条目信息更新", en: "Metadata Update" });
