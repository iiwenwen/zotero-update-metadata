import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  getMeta,
  isSupportedMetadataURL,
  type MetadataOperationSchema,
} from "./metadata";
import {
  showMetadataPreviewPaneForItems,
  showMetadataPreviewPaneResult,
} from "./metadataPreviewPane";

const MENU_ID = "updateMetadata";
const MENU_ACTION_BASE_ID = `${MENU_ID}-action`;
const ITEM_MENU_IDS = ["zotero-itemmenu", "zotero-itemmenu-popup"];

export const METADATA_MENU_PARENT = {
  id: MENU_ID,
  labelKey: "itemmenu-updateMetadata-label",
} as const;

export type MetadataMenuAction = {
  id: string;
  labelKey: string;
  schema: MetadataOperationSchema;
};

export const METADATA_MENU_ACTIONS: MetadataMenuAction[] = [
  {
    id: `${MENU_ACTION_BASE_ID}-update`,
    labelKey: "itemmenu-updateExistingMetadata-label",
    schema: "update",
  },
  {
    id: `${MENU_ACTION_BASE_ID}-save`,
    labelKey: "itemmenu-saveNewMetadata-label",
    schema: "save",
  },
];

let registeredMenuItems: Element[] = [];
let registeredMenuKey: string | null = null;
let selectionGuardTarget: Element | null = null;
let selectionGuardListener: ((event: Event) => void) | null = null;

type MenuContext = {
  items?: Zotero.Item[];
  menuElem?: Element;
  setEnabled?: (enabled: boolean) => void;
  setVisible?: (visible: boolean) => void;
};

type MainWindowWithPane = _ZoteroTypes.MainWindow & {
  ZoteroPane?: _ZoteroTypes.ZoteroPane;
};

type MenuManager = {
  registerMenu?: (options: unknown) => string | false;
  unregisterMenu?: (menuID: string) => boolean;
};

function findItemContextMenu(doc: Document) {
  return (
    ITEM_MENU_IDS.map((id) => doc.getElementById(id)).find(Boolean) ?? null
  );
}

function createMenuItem(doc: Document) {
  return ztoolkit.createXULElement(doc, "menuitem");
}

function createSubmenu(doc: Document) {
  return ztoolkit.createXULElement(doc, "menu");
}

function createMenuPopup(doc: Document) {
  return ztoolkit.createXULElement(doc, "menupopup");
}

function isRegularZoteroItem(item: Zotero.Item) {
  return typeof item?.isRegularItem === "function" && item.isRegularItem();
}

export function registerMenu(win: _ZoteroTypes.MainWindow) {
  const menuIcon = `chrome://${config.addonRef}/content/icons/favicon.png`;
  const menuManager = (Zotero as unknown as { MenuManager?: MenuManager })
    .MenuManager;

  unregisterMenu(win);

  if (menuManager?.registerMenu) {
    const registered = menuManager.registerMenu({
      menuID: MENU_ID,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "submenu",
          icon: menuIcon,
          onShowing: (_event: Event, context: MenuContext) => {
            configureParentMenuElement(context.menuElem, menuIcon);
            updateMenuDisabledState(win, context);
          },
          menus: METADATA_MENU_ACTIONS.map((action) => {
            return {
              menuType: "menuitem",
              onShowing: (_event: Event, context: MenuContext) => {
                configureActionMenuElement(context.menuElem, action);
                updateMenuDisabledState(win, context);
              },
              onCommand: (_event: Event, context: MenuContext = {}) =>
                void runMetadataAction(win, action.schema, context.items),
            };
          }),
        },
      ],
    });

    if (registered) {
      registeredMenuKey = registered;
      return;
    }

    ztoolkit.log("Zotero MenuManager rejected item context menu.");
  }

  registerFallbackMenu(win, menuIcon);
}

function registerFallbackMenu(win: _ZoteroTypes.MainWindow, menuIcon: string) {
  const doc = win.document;
  doc.getElementById(MENU_ID)?.remove();
  METADATA_MENU_ACTIONS.forEach((action) => {
    doc.getElementById(action.id)?.remove();
  });

  const itemContextMenu = findItemContextMenu(doc);
  if (!itemContextMenu) {
    ztoolkit.log("Zotero item context menu was not found.");
    return;
  }

  const parentMenu = createSubmenu(doc);
  configureParentMenuElement(parentMenu, menuIcon);

  const menuPopup = createMenuPopup(doc);
  METADATA_MENU_ACTIONS.forEach((action) => {
    const menuItem = createMenuItem(doc);
    configureActionMenuElement(menuItem, action);
    menuItem.addEventListener(
      "command",
      () => void runMetadataAction(win, action.schema),
    );
    menuPopup.append(menuItem);
  });

  parentMenu.append(menuPopup);
  itemContextMenu.append(parentMenu);
  registeredMenuItems = [parentMenu];

  updateMenuDisabledState(win);
}

function configureParentMenuElement(
  menuItem: Element | undefined,
  menuIcon: string,
) {
  menuItem?.setAttribute("id", METADATA_MENU_PARENT.id);
  menuItem?.setAttribute("label", getString(METADATA_MENU_PARENT.labelKey));
  menuItem?.setAttribute("class", "menu-iconic");
  menuItem?.setAttribute("image", menuIcon);
}

function configureActionMenuElement(
  menuItem: Element | undefined,
  action: MetadataMenuAction,
) {
  menuItem?.setAttribute("id", action.id);
  menuItem?.setAttribute("label", getString(action.labelKey));
}

function runMetadataAction(
  win: _ZoteroTypes.MainWindow,
  schema: MetadataOperationSchema,
  items?: Zotero.Item[],
) {
  const selectedItems = items ?? getSelectedItems(win);
  if (schema === "update") {
    showMetadataPreviewPaneForItems(selectedItems);
  }

  return getMeta({
    win,
    items: selectedItems,
    schema,
    collectionID: getSelectedCollectionID(win),
    onUpdatePreview:
      schema === "update" ? showMetadataPreviewPaneResult : undefined,
  });
}

function getSelectedItems(win: _ZoteroTypes.MainWindow) {
  return (win as MainWindowWithPane).ZoteroPane?.getSelectedItems() ?? [];
}

function getSelectedCollectionID(win: _ZoteroTypes.MainWindow) {
  return (win as MainWindowWithPane).ZoteroPane?.getSelectedCollection()?.id;
}

function getRegularItems(win: _ZoteroTypes.MainWindow, context?: MenuContext) {
  const items = context?.items ?? getSelectedItems(win);
  return items.filter(isRegularZoteroItem);
}

function canUpdateSelectedItems(
  win: _ZoteroTypes.MainWindow,
  context?: MenuContext,
) {
  const selectedItems = context?.items ?? getSelectedItems(win);
  const items = getRegularItems(win, context);
  return (
    items.length > 0 &&
    items.length === selectedItems.length &&
    items.every((item) => isSupportedMetadataURL(item.getField("url")))
  );
}

function updateMenuDisabledState(
  win: _ZoteroTypes.MainWindow,
  context?: MenuContext,
) {
  const enabled = canUpdateSelectedItems(win, context);
  const menuItems = context?.menuElem
    ? [context.menuElem]
    : [
        win.document.getElementById(METADATA_MENU_PARENT.id),
        ...METADATA_MENU_ACTIONS.map((action) =>
          win.document.getElementById(action.id),
        ),
      ].filter((item): item is Element => Boolean(item));

  context?.setVisible?.(true);
  context?.setEnabled?.(enabled);

  if (enabled) {
    menuItems.forEach((menuItem) => menuItem.removeAttribute("disabled"));
    return;
  }

  menuItems.forEach((menuItem) => menuItem.setAttribute("disabled", "true"));
}

export async function selectoritem(win: _ZoteroTypes.MainWindow) {
  if (registeredMenuKey) {
    return;
  }

  if (selectionGuardTarget && selectionGuardListener) {
    return;
  }

  const itemsTreeElement = win.document.getElementById("zotero-items-tree");
  if (!itemsTreeElement) {
    ztoolkit.log("Zotero items tree was not found.");
    return;
  }

  selectionGuardListener = () => updateMenuDisabledState(win);
  selectionGuardTarget = itemsTreeElement;
  itemsTreeElement.addEventListener("contextmenu", selectionGuardListener);
}

export function unregisterMenu(win?: _ZoteroTypes.MainWindow) {
  if (registeredMenuKey) {
    (
      Zotero as unknown as { MenuManager?: MenuManager }
    ).MenuManager?.unregisterMenu?.(registeredMenuKey);
    registeredMenuKey = null;
  }

  registeredMenuItems.forEach((menuItem) => menuItem.remove());
  registeredMenuItems = [];
  win?.document.getElementById(MENU_ID)?.remove();
  METADATA_MENU_ACTIONS.forEach((action) => {
    win?.document.getElementById(action.id)?.remove();
  });

  if (selectionGuardTarget && selectionGuardListener) {
    selectionGuardTarget.removeEventListener(
      "contextmenu",
      selectionGuardListener,
    );
  }

  selectionGuardTarget = null;
  selectionGuardListener = null;
}
