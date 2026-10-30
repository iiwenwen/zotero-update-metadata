// 测试侧 FTL 读取器：解析真实 addon/locale/*/dialogs.ftl，交给生产实现 staticDialogCopy。
// 断言里写死的期望文案就是人工把关点：FTL 改错字，测试会失败。
const { readFileSync } = require("node:fs");
const path = require("node:path");

const LOCALE_ROOT = path.join(__dirname, "..", "..", "addon", "locale");
const DIALOG_LOCALES = ["zh-CN", "en-US"];

/** 只支持本项目用到的子集：单行消息 + 缩进续行 + # 注释。 */
function parseFtl(source) {
  const values = {};
  let current = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) { current = null; continue; }
    const start = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (start) {
      current = start[1];
      values[current] = start[2].trim();
      continue;
    }
    if (current && /^\s+\S/.test(raw)) {
      values[current] = `${values[current]} ${line.trim()}`.trim();
    }
  }
  return values;
}

function readDialogMessages(locale) {
  return parseFtl(readFileSync(path.join(LOCALE_ROOT, locale, "dialogs.ftl"), "utf8"));
}

function readFtl(locale, file) {
  return parseFtl(readFileSync(path.join(LOCALE_ROOT, locale, file), "utf8"));
}

function loadDialogCopy(locale = "zh-CN") {
  const values = readDialogMessages(locale);
  const copy = globalThis.addon.api.staticDialogCopy(values);
  return { values, copy };
}

/**
 * 把 { layout, fills } 里登记的文案写回布局节点，模拟真实窗口挂载后的填充。
 * 分派交给生产 fillCopy（含 attribute 分支），这里只提供 getElementById 适配层。
 * 返回同一个 layout，便于链式断言。
 */
function renderCopy(built, copy) {
  const index = new Map();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.id) index.set(node.id, node);
    for (const child of node.children || []) walk(child);
  };
  walk(built.layout);
  const elementFor = (node) => ({
    get textContent() { return node.properties?.textContent; },
    set textContent(value) { node.properties = { ...(node.properties || {}), textContent: value }; },
    setAttribute(name, value) { node.attributes = { ...(node.attributes || {}), [name]: value }; },
  });
  globalThis.addon.api.fillCopy({ getElementById: (id) => { const node = index.get(id); return node ? elementFor(node) : null; } }, copy, built.fills);
  return built.layout;
}

module.exports = { DIALOG_LOCALES, parseFtl, readDialogMessages, readFtl, loadDialogCopy, renderCopy };
