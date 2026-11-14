import { PLUGIN_ID } from "../config";
// ztoolkit 装配（toolkit 6.0.0）
// 用 ZoteroToolkit（/ztoolkit 子路径导出）替代手动拼接 BasicTool/UITool/DialogHelper。
// 注意：ZoteroToolkit 含 Dialog/ProgressWindow/Keyboard 等，但无菜单工具（菜单用 Zotero 原生 MenuManager）。
// toolkit 6 不再自动注册 zotero://plugin 与 zotero://ztoolkit-debug，升级前 5.2.0 会随实例化注册，勿回退。
import { ZoteroToolkit } from "zotero-plugin-toolkit/ztoolkit";

export function createZToolkit() {
  const ztoolkit = new ZoteroToolkit();
  ztoolkit.basicOptions.log.prefix = "[zmta]";
  ztoolkit.basicOptions.api.pluginID = PLUGIN_ID;
  return ztoolkit;
}
