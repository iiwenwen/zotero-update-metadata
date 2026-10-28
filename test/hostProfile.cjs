// 只用于宿主测试；测试运行器提供项目根，实际profile和dataDir仍须同时严格匹配。
function assertDedicatedTestProfile(host, services, ci) {
  const root = host.Prefs.get("extensions.zmta.testProjectRoot", true);
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("缺少测试运行器提供的项目根目录，拒绝操作宿主");
  }
  const normalize = (value) => String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  const projectRoot = normalize(root);
  if (!/^(?:\/[^/]|[A-Za-z]:\/|\/\/[^/])/.test(projectRoot)
      || projectRoot.split("/").some((part) => part === "." || part === "..")
      || /^[A-Za-z]:$/.test(projectRoot) || !projectRoot) {
    throw new Error("测试项目根目录必须是明确的绝对路径");
  }
  const profile = normalize(services.dirsvc.get("ProfD", ci.nsIFile).path);
  const data = normalize(host.DataDirectory.dir);
  if (profile !== `${projectRoot}/.scaffold/test/profile`
      || data !== `${projectRoot}/.scaffold/test/data`) {
    throw new Error("宿主未绑定该项目的隔离profile和dataDir，拒绝操作");
  }
}

module.exports = { assertDedicatedTestProfile };
