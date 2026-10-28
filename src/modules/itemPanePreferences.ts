import { clearPref, getPref } from "../utils/prefs";

export const METADATA_PREFS_PANE_ID = "zmta-metadata-preferences";
const DEFAULTS = {
  showItemPane: true,
  defaultSelectAttachments: false,
  defaultSelectNotes: false,
} as const;

/** 未设置侧栏按默认开启；非法类型和读取错误均关闭，菜单仍可用。 */
export function isItemPaneShown(): boolean {
  try {
    const value = getPref("showItemPane");
    return value === undefined ? true : value === true;
  } catch {
    return false;
  }
}

/** 只恢复普通设置三项，隐藏的技术偏好、日志和资料库均不触碰。 */
export function resetMetadataPreferences(): void {
  for (const key of Object.keys(DEFAULTS)) clearPref(key);
}

interface PreferenceBinding {
  control: any;
  synchronize: () => void;
  observer: symbol;
}
interface PreferenceWindow {
  bindings: Map<string, PreferenceBinding>;
  onUnload: () => void;
}
const preferenceWindows = new Map<any, PreferenceWindow>();

function removeBinding(binding: PreferenceBinding): void {
  binding.control.removeEventListener("syncfrompreference", binding.synchronize);
  Zotero.Prefs.unregisterObserver(binding.observer);
}

/** 原生绑定负责持久化；本层仅严格同步显示，绝不写回虚构迁移值。 */
export function initializeMetadataPreferences(win: any): void {
  for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
    const control = win?.document?.getElementById(`zotero-prefpane-zmta-${key}`);
    if (!control) continue;
    let context = preferenceWindows.get(win);
    if (!context) {
      context = { bindings: new Map(), onUnload: () => unloadMetadataPreferences(win) };
      preferenceWindows.set(win, context);
      win.addEventListener("unload", context.onUnload);
    }
    const previous = context.bindings.get(key);
    if (previous?.control === control) {
      previous.synchronize();
      continue;
    }
    if (previous) removeBinding(previous);
    const synchronize = () => {
      try {
        const value = getPref(key);
        control.checked = value === undefined ? defaultValue : value === true;
      } catch {
        control.checked = false;
      }
    };
    // 原生_syncFromPref遇到!!value未变会直接返回，不保证发同步事件。
    // load时注册在宿主观察者之后，保证非法类型也按实际保守行为显示。
    const observer = Zotero.Prefs.registerObserver(`extensions.zmta.${key}`, synchronize, true);
    control.addEventListener("syncfrompreference", synchronize);
    context.bindings.set(key, { control, synchronize, observer });
    synchronize();
  }
}

/** 设置窗口关闭释放本窗口；插件停用时无参数统一释放。 */
export function unloadMetadataPreferences(win?: any): void {
  const entries = win ? [[win, preferenceWindows.get(win)] as const] : [...preferenceWindows.entries()];
  for (const [ownerWindow, context] of entries) {
    if (!context) continue;
    preferenceWindows.delete(ownerWindow);
    ownerWindow.removeEventListener("unload", context.onUnload);
    for (const binding of context.bindings.values()) {
      try { removeBinding(binding); } catch { /* 继续释放其余控件 */ }
    }
    context.bindings.clear();
  }
}
