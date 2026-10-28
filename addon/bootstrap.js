// Zotero 插件引导入口：Zotero 官方 Make It Red 标准模式。
// 用 amIAddonManagerStartup.registerChrome 注册 chrome://，
// Services.scriptloader.loadSubScript 加载主脚本，
// onMainWindowLoad 等主窗口就绪后再注册菜单。
// 注意：Zotero 10 的 bootstrap 作用域里 Services 是全局的，不要 import。

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, rootURI }, reason) {
  // 注册 chrome://content 映射
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zmta", rootURI + "content/"],
  ]);

  // 加载主脚本（src/index.ts 编译产物 zmta.js）
  const ctx = { rootURI };
  ctx._globalThis = ctx;
  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/zmta.js`,
    ctx,
  );

  // 主脚本挂载 Zotero.zmtaAddon 后，调用 hooks.onStartup()
  await Zotero.zmtaAddon?.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  try {
    await Zotero.zmtaAddon?.hooks.onMainWindowLoad(window);
  } catch (e) {
    Zotero.debug(`[zmta] onMainWindowLoad error: ${e}`);
  }
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.zmtaAddon?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  await Zotero.zmtaAddon?.hooks.onShutdown();
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
