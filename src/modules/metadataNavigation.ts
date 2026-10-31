// 审核条目/更新记录的只读导航适配，不参与字段授权。
// 在 loadCallback 创建原生 select，避开 Toolkit 5.2.0 对声明式 select 的 popup 改写。
export interface MetadataNavigationRow { key: string; label: string; optionID?: string }

export type ReviewNavigationState = "ready" | "identity" | "blocked";
export interface ReviewNavigationRow {
  key: string;
  title: string;
  metaID: string;
  state(): ReviewNavigationState;
}

/** 审核专用行列表：筛选仅改变可见范围，永不更改审核选择。记录页仍用原生 select。 */
export function mountReviewNavigation(
  win: any, containerID: string, rows: readonly ReviewNavigationRow[], initialKey: string,
  labels: { filters: readonly { key: "all" | ReviewNavigationState; label: string }[]; empty: string },
  onSelect: (key: string) => void,
): { refresh(): void; dispose(): void } {
  const doc = win?.document;
  const container = doc?.getElementById(containerID);
  if (!container || !doc.createElementNS || rows.length < 2) return { refresh() {}, dispose() {} };
  const make = (tag: string, className: string, id?: string) => {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    node.className = className;
    if (id) node.id = id;
    return node;
  };
  let active = initialKey;
  let filter = "all";
  let disposed = false;
  const removers: (() => void)[] = [];
  const listen = (node: any, name: string, fn: (event: any) => void) => {
    node.addEventListener(name, fn);
    removers.push(() => node.removeEventListener(name, fn));
  };
  const filters = make("div", "zmta-nav-filters");
  const list = make("div", "zmta-nav-rows");
  const empty = make("p", "zmta-nav-empty");
  empty.textContent = labels.empty;
  empty.setAttribute("role", "status");
  const buttons = rows.map((row, index) => {
    const button = make("button", "zmta-nav-row", `${containerID}-row-${index}`);
    button.type = "button";
    const dot = make("span", "zmta-nav-dot");
    dot.setAttribute("aria-hidden", "true");
    const text = make("span", "zmta-nav-text");
    const title = make("span", "zmta-nav-title");
    title.textContent = row.title;
    const meta = make("span", "zmta-nav-meta", row.metaID);
    text.appendChild(title); text.appendChild(meta);
    button.appendChild(dot); button.appendChild(text); list.appendChild(button);
    listen(button, "click", () => { if (!disposed) select(row.key); });
    // 原生按钮负责 Tab/Space/Enter；方向键、Home/End 在当前筛选范围内移动。
    listen(button, "keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const visible = buttons.filter(entry => !entry.hidden);
      const index = visible.indexOf(button);
      const target = event.key === "Home" ? visible[0] : event.key === "End" ? visible.at(-1)
        : visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
      event.preventDefault(); target?.focus(); target?.click();
    });
    return button;
  });
  const chips = labels.filters.map(entry => {
    const button = make("button", "zmta-nav-chip", `${containerID}-filter-${entry.key}`);
    button.type = "button";
    const label = make("span", ""); label.textContent = entry.label;
    const count = make("span", "zmta-nav-count");
    button.appendChild(label); button.appendChild(count); filters.appendChild(button);
    listen(button, "click", () => { if (!disposed) { filter = entry.key; refresh(); } });
    return { ...entry, button, count };
  });
  function select(key: string) {
    active = key;
    buttons.forEach((button, index) => button.setAttribute("aria-current", rows[index].key === key ? "page" : "false"));
    onSelect(key);
  }
  function refresh() {
    if (disposed) return;
    const states = rows.map(row => row.state());
    buttons.forEach((button, index) => {
      button.setAttribute("data-state", states[index]);
      button.hidden = filter !== "all" && (filter === "ready" ? states[index] === "blocked" : states[index] !== filter);
    });
    chips.forEach(entry => {
      entry.count.textContent = String(entry.key === "all" ? rows.length : states.filter(state => entry.key === "ready" ? state !== "blocked" : state === entry.key).length);
      entry.button.setAttribute("aria-pressed", String(entry.key === filter));
    });
    const visible = rows.filter((_row, index) => !buttons[index].hidden);
    empty.hidden = visible.length > 0;
    if (!visible.some(row => row.key === active)) select(visible[0]?.key || "");
    else buttons.forEach((button, index) => button.setAttribute("aria-current", rows[index].key === active ? "page" : "false"));
  }
  container.appendChild(filters); container.appendChild(list); container.appendChild(empty);
  refresh();
  return { refresh, dispose() {
    if (disposed) return;
    disposed = true; removers.forEach(remove => remove());
    filters.remove(); list.remove(); empty.remove();
  } };
}

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
