import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  formatMetadataPreviewValue,
  type MetadataChange,
  type MetadataSkip,
  type MetadataUpdatePreviewForItemResult,
} from "./metadata";

const PANE_ID = `${config.addonRef}-metadata-preview`;
const STYLE_URI = `chrome://${config.addonRef}/content/zoteroPane.css`;
const ICON_URI = `chrome://${config.addonRef}/content/icons/favicon.png`;

let registeredSectionKey: string | null = null;
let registeredStyleURI: nsIURI | null = null;
let refreshMetadataPreviewPane: (() => Promise<void>) | null = null;
let visibleItemKeys = new Set<string>();
let previewResultsByItemKey = new Map<string, MetadataPreviewPaneState>();

type SectionHookArgs = _ZoteroTypes.ItemPaneManagerSection.SectionHookArgs;
type SectionInitHookArgs =
  _ZoteroTypes.ItemPaneManagerSection.SectionInitHookArgs;
type MetadataPreviewPaneState =
  MetadataUpdatePreviewForItemResult | { status: "pending" };

export function registerMetadataPreviewPane() {
  registerMetadataPreviewStyles();

  if (registeredSectionKey) {
    return;
  }

  const registered = Zotero.ItemPaneManager?.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    sidenav: {
      icon: ICON_URI,
      l10nID: `${config.addonRef}-metadata-preview-pane-label`,
    },
    header: {
      icon: ICON_URI,
      l10nID: `${config.addonRef}-metadata-preview-pane-label`,
    },
    bodyXHTML: `<div class="metadata-preview-pane"></div>`,
    onInit: initializeMetadataPreviewPane,
    onRender: renderInitialState,
    onAsyncRender: renderMetadataPreview,
    onDestroy: destroyMetadataPreviewPane,
  });

  if (!registered) {
    ztoolkit.log(
      "Zotero item pane metadata preview section was not registered.",
    );
    return;
  }

  registeredSectionKey = registered;
}

export function unregisterMetadataPreviewPane() {
  if (registeredSectionKey) {
    Zotero.ItemPaneManager?.unregisterSection(registeredSectionKey);
    registeredSectionKey = null;
  }

  refreshMetadataPreviewPane = null;
  visibleItemKeys = new Set<string>();
  previewResultsByItemKey = new Map<string, MetadataPreviewPaneState>();
  unregisterMetadataPreviewStyles();
}

export function showMetadataPreviewPaneForItems(items: Zotero.Item[]) {
  visibleItemKeys = new Set(
    items.map(getItemKey).filter((key): key is string => Boolean(key)),
  );

  if (!visibleItemKeys.size) {
    return;
  }

  for (const itemKey of visibleItemKeys) {
    previewResultsByItemKey.set(itemKey, { status: "pending" });
  }

  refreshPreviewPane();
}

export function showMetadataPreviewPaneResult(
  item: Zotero.Item,
  result: MetadataUpdatePreviewForItemResult,
) {
  const itemKey = getItemKey(item);
  if (!itemKey) {
    return;
  }

  visibleItemKeys.add(itemKey);
  previewResultsByItemKey.set(itemKey, result);
  refreshPreviewPane();
}

function registerMetadataPreviewStyles() {
  try {
    const styleURI = Services.io.newURI(STYLE_URI);
    const styleSheetService = getStyleSheetService();
    const authorSheet = styleSheetService.AUTHOR_SHEET ?? 2;

    if (!styleSheetService.sheetRegistered(styleURI, authorSheet)) {
      styleSheetService.loadAndRegisterSheet(styleURI, authorSheet);
    }
    registeredStyleURI = styleURI;
  } catch (err) {
    ztoolkit.log("Unable to register metadata preview stylesheet", err);
  }
}

function unregisterMetadataPreviewStyles() {
  if (!registeredStyleURI) {
    return;
  }

  try {
    const styleSheetService = getStyleSheetService();
    const authorSheet = styleSheetService.AUTHOR_SHEET ?? 2;

    if (styleSheetService.sheetRegistered(registeredStyleURI, authorSheet)) {
      styleSheetService.unregisterSheet(registeredStyleURI, authorSheet);
    }
  } catch (err) {
    ztoolkit.log("Unable to unregister metadata preview stylesheet", err);
  } finally {
    registeredStyleURI = null;
  }
}

function getStyleSheetService() {
  return (Components.classes as any)[
    "@mozilla.org/content/style-sheet-service;1"
  ].getService(Components.interfaces.nsIStyleSheetService);
}

function initializeMetadataPreviewPane(props: SectionInitHookArgs) {
  refreshMetadataPreviewPane = () => props.refresh();
  renderInitialState(props);
}

function destroyMetadataPreviewPane() {
  refreshMetadataPreviewPane = null;
}

function renderInitialState(props: SectionHookArgs) {
  const root = getPreviewRoot(props.body);
  disablePreviewPane(props, root);
}

function renderMetadataPreview(props: SectionHookArgs) {
  const root = getPreviewRoot(props.body);
  const regularItem = props.item?.isRegularItem?.() === true;
  const previewState = getPreviewStateForItem(props.item);

  if (!regularItem || !previewState) {
    disablePreviewPane(props, root);
    return;
  }

  props.setEnabled(true);
  if (previewState.status === "pending") {
    root.dataset.renderToken = String(
      Number(root.dataset.renderToken || "0") + 1,
    );
    root.dataset.previewStatus = "pending";
    props.setSectionSummary(getString("metadata-preview-pane-loading"));
    renderMessage(root, getString("metadata-preview-pane-loading"), {
      loading: true,
      tone: "loading",
    });
    return;
  }

  root.dataset.renderToken = String(
    Number(root.dataset.renderToken || "0") + 1,
  );
  renderPreviewResult(root, previewState);
  props.setSectionSummary(getPreviewSummary(previewState));
}

function disablePreviewPane(props: SectionHookArgs, root: HTMLElement) {
  props.setEnabled(false);
  props.setSectionSummary("");
  root.replaceChildren();
}

function getPreviewStateForItem(item: Zotero.Item | undefined) {
  const itemKey = getItemKey(item);
  if (!itemKey || !visibleItemKeys.has(itemKey)) {
    return null;
  }

  return previewResultsByItemKey.get(itemKey) ?? null;
}

function getItemKey(item: Zotero.Item | undefined) {
  if (!item) {
    return "";
  }

  const itemID = Number(item.id || 0);
  if (!itemID) {
    return "";
  }

  const libraryID = Number(item.libraryID || 0);
  return `${libraryID}:${itemID}`;
}

function getPreviewRoot(body: HTMLDivElement) {
  const existing = body.querySelector<HTMLDivElement>(".metadata-preview-pane");
  if (existing) {
    return existing;
  }

  const root = body.ownerDocument!.createElement("div");
  root.className = "metadata-preview-pane";
  body.replaceChildren(root);
  return root;
}

function renderPreviewResult(
  root: HTMLElement,
  result: MetadataUpdatePreviewForItemResult,
) {
  root.replaceChildren();
  root.dataset.previewStatus = result.status;

  if (result.status === "ready") {
    appendOverview(root, {
      summary: getPreviewSummary(result),
      provider: result.provider,
      changeCount: result.update.applied.length,
      skipCount: result.update.skipped.length,
    });
    appendChanges(root, result.update.applied);
    appendSkips(root, result.update.skipped);
    return;
  }

  if (result.status === "skipped") {
    appendOverview(root, {
      summary: getString("metadata-preview-pane-empty"),
      skipCount: result.update.skipped.length,
    });
    appendSkips(root, result.update.skipped);
    if (!result.update.skipped.length) {
      renderMessage(root, getString("metadata-preview-pane-empty"));
    }
    return;
  }

  if (result.status === "error") {
    renderMessage(root, getString("metadata-preview-pane-error"), {
      tone: "error",
    });
    appendDetails(root, result.error);
    return;
  }

  renderMessage(root, getUnavailableMessage(result.reason), {
    tone: "warning",
  });
}

function appendOverview(
  root: HTMLElement,
  options: {
    summary: string;
    provider?: string;
    changeCount?: number;
    skipCount?: number;
  },
) {
  const doc = root.ownerDocument!;
  const overview = doc.createElement("div");
  overview.className = "metadata-preview-overview";

  const summary = doc.createElement("div");
  summary.className = "metadata-preview-summary";
  summary.textContent = options.summary;
  overview.append(summary);

  const meta = doc.createElement("div");
  meta.className = "metadata-preview-meta";
  if (options.provider) {
    meta.append(createProviderChip(root, options.provider));
  }
  if (typeof options.changeCount === "number") {
    meta.append(
      createMetric(
        root,
        "metadata-preview-metric-change",
        getString("metadata-preview-pane-updatable"),
        options.changeCount,
      ),
    );
  }
  if (typeof options.skipCount === "number") {
    meta.append(
      createMetric(
        root,
        "metadata-preview-metric-skip",
        getString("metadata-preview-pane-skipped"),
        options.skipCount,
      ),
    );
  }
  if (meta.children.length) {
    overview.append(meta);
  }

  root.append(overview);
}

function createProviderChip(root: HTMLElement, provider: string) {
  const providerElement = root.ownerDocument!.createElement("div");
  providerElement.className = "metadata-preview-provider";
  providerElement.textContent = `${getString(
    "metadata-preview-pane-provider",
  )}: ${provider}`;
  return providerElement;
}

function createMetric(
  root: HTMLElement,
  className: string,
  label: string,
  count: number,
) {
  const metric = root.ownerDocument!.createElement("div");
  metric.className = `metadata-preview-metric ${className}`;

  const value = root.ownerDocument!.createElement("span");
  value.className = "metadata-preview-metric-value";
  value.textContent = String(count);

  const labelElement = root.ownerDocument!.createElement("span");
  labelElement.className = "metadata-preview-metric-label";
  labelElement.textContent = label;

  metric.append(value, labelElement);
  return metric;
}

function appendChanges(root: HTMLElement, changes: MetadataChange[]) {
  if (!changes.length) {
    return;
  }

  const group = createGroup(
    root,
    getString("metadata-preview-pane-updatable"),
    changes.length,
    "change",
  );
  for (const change of changes) {
    group.append(createChangeRow(root, change));
  }
  root.append(group);
}

function appendSkips(root: HTMLElement, skips: MetadataSkip[]) {
  if (!skips.length) {
    return;
  }

  const group = createGroup(
    root,
    getString("metadata-preview-pane-skipped"),
    skips.length,
    "skip",
  );
  for (const skip of skips) {
    group.append(createSkipRow(root, skip));
  }
  root.append(group);
}

function createGroup(
  root: HTMLElement,
  title: string,
  count: number,
  tone: "change" | "skip",
) {
  const doc = root.ownerDocument!;
  const group = doc.createElement("section");
  group.className = `metadata-preview-group metadata-preview-group-${tone}`;

  const headingRow = doc.createElement("div");
  headingRow.className = "metadata-preview-group-heading";
  const heading = doc.createElement("h4");
  heading.textContent = title;
  const countElement = doc.createElement("span");
  countElement.className = "metadata-preview-group-count";
  countElement.textContent = String(count);
  headingRow.append(heading, countElement);
  group.append(headingRow);

  return group;
}

function createChangeRow(root: HTMLElement, change: MetadataChange) {
  const doc = root.ownerDocument!;
  const row = doc.createElement("div");
  row.className = "metadata-preview-row metadata-preview-row-change";

  const field = doc.createElement("div");
  field.className = "metadata-preview-field";
  field.textContent = getFieldLabel(change.field);

  const oldValue = doc.createElement("div");
  oldValue.className = "metadata-preview-value metadata-preview-value-old";
  oldValue.dataset.valueRole = "old";
  oldValue.append(
    createValueLabel(root, getString("metadata-preview-value-current")),
    createValueText(root, formatMetadataPreviewValue(change.oldValue)),
  );

  const newValue = doc.createElement("div");
  newValue.className = "metadata-preview-value metadata-preview-value-new";
  newValue.dataset.valueRole = "new";
  newValue.append(
    createValueLabel(root, getString("metadata-preview-value-source")),
    createValueText(root, formatMetadataPreviewValue(change.newValue)),
  );

  row.append(field, oldValue, newValue);
  return row;
}

function createValueLabel(root: HTMLElement, label: string) {
  const labelElement = root.ownerDocument!.createElement("span");
  labelElement.className = "metadata-preview-value-label";
  labelElement.textContent = label;
  return labelElement;
}

function createValueText(root: HTMLElement, value: string) {
  const valueElement = root.ownerDocument!.createElement("span");
  valueElement.className = "metadata-preview-value-text";
  valueElement.textContent = value;
  return valueElement;
}

function createSkipRow(root: HTMLElement, skip: MetadataSkip) {
  const doc = root.ownerDocument!;
  const row = doc.createElement("div");
  row.className = "metadata-preview-row metadata-preview-row-skip";

  const field = doc.createElement("div");
  field.className = "metadata-preview-field";
  field.textContent = getFieldLabel(skip.field);

  const reason = doc.createElement("div");
  reason.className = "metadata-preview-reason";
  reason.textContent = getSkipReasonLabel(skip.reason);

  row.append(field, reason);
  return row;
}

function renderMessage(
  root: HTMLElement,
  message: string,
  options: { loading?: boolean; tone?: "loading" | "error" | "warning" } = {},
) {
  root.replaceChildren();
  const messageElement = root.ownerDocument!.createElement("div");
  messageElement.className = [
    "metadata-preview-message",
    options.loading ? "metadata-preview-message-loading" : "",
    options.tone ? `metadata-preview-message-${options.tone}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  messageElement.setAttribute(
    "role",
    options.tone === "error" ? "alert" : "status",
  );
  messageElement.setAttribute("aria-live", "polite");
  messageElement.textContent = message;
  root.append(messageElement);
}

function appendDetails(root: HTMLElement, details: string) {
  if (!details) {
    return;
  }

  const detailElement = root.ownerDocument!.createElement("div");
  detailElement.className = "metadata-preview-details";
  detailElement.textContent = details;
  root.append(detailElement);
}

function getPreviewSummary(result: MetadataUpdatePreviewForItemResult) {
  if (result.status === "ready") {
    return getString("metadata-preview-pane-summary-ready", {
      args: {
        count: result.update.applied.length,
      },
    });
  }

  if (result.status === "skipped") {
    return getString("metadata-preview-pane-summary-empty");
  }

  if (result.status === "error") {
    return getString("metadata-preview-pane-summary-error");
  }

  return getString("metadata-preview-pane-summary-unavailable");
}

function getUnavailableMessage(reason: string) {
  if (reason === "missing URL") {
    return getString("metadata-preview-pane-missing-url");
  }

  if (reason === "unsupported URL") {
    return getString("metadata-preview-pane-unsupported-url");
  }

  return getString("metadata-preview-pane-unavailable");
}

function getSkipReasonLabel(reason: string) {
  switch (reason) {
    case "skip unchanged creators":
    case "skip unchanged value":
    case "skip unchanged tags":
      return getString("metadata-preview-skip-unchanged");
    case "skip empty creators":
    case "skip empty value":
    case "skip empty tags":
      return getString("metadata-preview-skip-empty");
    case "skip unrelated title":
      return getString("metadata-preview-skip-unrelated-title");
    case "skip lower precision date":
      return getString("metadata-preview-skip-lower-precision-date");
    default:
      return getString("metadata-preview-skip-default");
  }
}

function refreshPreviewPane() {
  void refreshMetadataPreviewPane?.().catch((err) => {
    ztoolkit.log("Unable to refresh metadata preview pane", err);
  });
}

function getFieldLabel(field: string) {
  if (field === "creators") {
    return getString("metadata-preview-field-creators");
  }
  if (field === "tags") {
    return getString("metadata-preview-field-tags");
  }
  if (field === "itemType") {
    return getString("metadata-preview-field-itemType");
  }

  try {
    const fieldID = Zotero.ItemFields.getID(field);
    if (fieldID) {
      return Zotero.ItemFields.getLocalizedString(field);
    }
  } catch {
    // Fall back to the raw field key when Zotero has no localized label.
  }

  return field;
}
