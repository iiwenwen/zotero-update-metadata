// 偏好读写（照 template utils/prefs.ts）
// prefsPrefix: extensions.zmta（见 zotero-plugin.config.ts build.prefs.prefix）
const PREFS_PREFIX = "extensions.zmta";

export function getPref(key: string) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true);
}

export function setPref(key: string, value: any) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}
