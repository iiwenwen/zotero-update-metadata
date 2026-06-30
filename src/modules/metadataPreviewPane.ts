import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  formatMetadataPreviewValue,
  previewMetadataUpdateForItem,
  type MetadataChange,
  type MetadataSkip,
  type MetadataUpdatePreviewForItemResult,
} from "./metadata";

const PANE_ID = `${config.addonRef}-metadata-preview`;
const STYLE_URI = `chrome://${config.addonRef}/content/zoteroPane.css`;
const ICON_URI = `chrome://${config.addonRef}/content/icons/favicon.png`;

let registeredSectionKey: string | null = null;
let registeredStyleURI: nsIURI | null = null;

type SectionHookArgs = _ZoteroTypes.ItemPaneManagerSection.SectionHookArgs;

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
    onRender: renderInitialState,
    onAsyncRender: renderMetadataPreview,
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

  unregisterMetadataPreviewStyles();
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

function renderInitialState(props: SectionHookArgs) {
  const root = getPreviewRoot(props.body);
  renderMessage(root, getString("metadata-preview-pane-loading"));
}

async function renderMetadataPreview(props: SectionHookArgs) {
  const root = getPreviewRoot(props.body);
  const token = nextRenderToken(root);
  const regularItem = props.item?.isRegularItem?.() === true;

  props.setEnabled(regularItem);
  if (!regularItem) {
    props.setSectionSummary("");
    renderMessage(root, getString("metadata-preview-pane-unavailable"));
    return;
  }

  props.setSectionSummary(getString("metadata-preview-pane-loading"));
  renderMessage(root, getString("metadata-preview-pane-loading"), {
    loading: true,
  });

  const result = await previewMetadataUpdateForItem(props.item);
  if (root.dataset.renderToken !== token) {
    return;
  }

  renderPreviewResult(root, result);
  props.setSectionSummary(getPreviewSummary(result));
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

function nextRenderToken(root: HTMLElement) {
  const token = String(Number(root.dataset.renderToken || "0") + 1);
  root.dataset.renderToken = token;
  return token;
}

function renderPreviewResult(
  root: HTMLElement,
  result: MetadataUpdatePreviewForItemResult,
) {
  root.replaceChildren();

  if (result.status === "ready") {
    appendProvider(root, result.provider);
    appendChanges(root, result.update.applied);
    appendSkips(root, result.update.skipped);
    return;
  }

  if (result.status === "skipped") {
    appendSkips(root, result.update.skipped);
    if (!result.update.skipped.length) {
      renderMessage(root, getString("metadata-preview-pane-empty"));
    }
    return;
  }

  if (result.status === "error") {
    renderMessage(root, getString("metadata-preview-pane-error"));
    appendDetails(root, result.error);
    return;
  }

  renderMessage(root, getUnavailableMessage(result.reason));
}

function appendProvider(root: HTMLElement, provider: string) {
  const doc = root.ownerDocument!;
  const providerElement = doc.createElement("div");
  providerElement.className = "metadata-preview-provider";
  providerElement.textContent = `${getString(
    "metadata-preview-pane-provider",
  )}: ${provider}`;
  root.append(providerElement);
}

function appendChanges(root: HTMLElement, changes: MetadataChange[]) {
  if (!changes.length) {
    return;
  }

  const group = createGroup(root, getString("metadata-preview-pane-updatable"));
  for (const change of changes) {
    group.append(createChangeRow(root, change));
  }
  root.append(group);
}

function appendSkips(root: HTMLElement, skips: MetadataSkip[]) {
  if (!skips.length) {
    return;
  }

  const group = createGroup(root, getString("metadata-preview-pane-skipped"));
  for (const skip of skips) {
    group.append(createSkipRow(root, skip));
  }
  root.append(group);
}

function createGroup(root: HTMLElement, title: string) {
  const doc = root.ownerDocument!;
  const group = doc.createElement("section");
  group.className = "metadata-preview-group";

  const heading = doc.createElement("h4");
  heading.textContent = title;
  group.append(heading);

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
  oldValue.textContent = formatMetadataPreviewValue(change.oldValue);

  const newValue = doc.createElement("div");
  newValue.className = "metadata-preview-value metadata-preview-value-new";
  newValue.textContent = formatMetadataPreviewValue(change.newValue);

  row.append(field, oldValue, newValue);
  return row;
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
  reason.textContent = skip.reason;

  row.append(field, reason);
  return row;
}

function renderMessage(
  root: HTMLElement,
  message: string,
  options: { loading?: boolean } = {},
) {
  root.replaceChildren();
  const messageElement = root.ownerDocument!.createElement("div");
  messageElement.className = options.loading
    ? "metadata-preview-message metadata-preview-message-loading"
    : "metadata-preview-message";
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
