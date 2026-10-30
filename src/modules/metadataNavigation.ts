// 审核条目/更新记录的只读导航适配，不参与字段授权。
// 在 loadCallback 创建原生 select，避开 Toolkit 5.2.0 对声明式 select 的 popup 改写。
export interface MetadataNavigationRow { key: string; label: string; optionID?: string }

export function mountMetadataNavigation(
  win: any, containerID: string, rows: readonly MetadataNavigationRow[], initialKey: string,
  onSelect: (key: string) => void,
): () => void {
  const doc = win?.document;
  const container = doc?.getElementById(containerID);
  if (!container || !doc.createElementNS || rows.length < 2) return () => {};
  const select = doc.createElementNS("http://www.w3.org/1999/xhtml", "select");
  select.id = `${containerID}-select`;
  select.className = "zmta-native-navigation";
  select.setAttribute("aria-label", container.getAttribute("aria-label") || "选择记录");
  for (const row of rows) {
    const option = doc.createElementNS("http://www.w3.org/1999/xhtml", "option");
    option.value = row.key;
    option.textContent = row.label;
    if (row.optionID) option.id = row.optionID;
    select.appendChild(option);
  }
  select.value = rows.some(row => row.key === initialKey) ? initialKey : rows[0].key;
  const media = win.matchMedia?.("(max-width: 760px)");
  const resize = () => { select.size = media?.matches ? 1 : Math.min(10, rows.length); };
  resize();
  const change = () => { if (rows.some(row => row.key === select.value)) onSelect(select.value); };
  select.addEventListener("change", change);
  media?.addEventListener("change", resize);
  container.appendChild(select);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    select.removeEventListener("change", change);
    media?.removeEventListener("change", resize);
    select.remove();
  };
}
