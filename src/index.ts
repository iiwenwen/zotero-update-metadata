// 入口：addon 实例 + hooks 挂载（参考 template src/index.ts）
import Addon from "./addon";

declare const Zotero: any;
declare const _globalThis: any;

// 创建 addon 实例，挂成全局 addon（hooks.ts 里引用 addon.data）
if (!_globalThis.addon) {
  _globalThis.addon = new Addon();
  // @ts-expect-error - 挂到 Zotero 全局，bootstrap 可读
  Zotero.zmtaAddon = _globalThis.addon;
}

// 保存 rootURI（bootstrap 的 loadSubScript ctx 传入；设置界面 src 用它）
// @ts-expect-error - rootURI 来自 bootstrap ctx
if (_globalThis.rootURI) {
  // @ts-expect-error - addon 全局
  addon.data.rootURI = _globalThis.rootURI;
}
