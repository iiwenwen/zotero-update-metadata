import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getMeta, isSupportedMetadataURL } from "./metadata";

const MENU_ID = "updateMetadata";
const ITEM_MENU_IDS = ["zotero-itemmenu", "zotero-itemmenu-popup"];

let registeredMenuItem: Element | null = null;
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
          menuType: "menuitem",
          icon: menuIcon,
          onShowing: (_event: Event, context: MenuContext) => {
            context.menuElem?.setAttribute("id", MENU_ID);
            context.menuElem?.setAttribute(
              "label",
              getString("itemmenu-updateMetadata-label"),
            );
            updateMenuDisabledState(win, context);
          },
          onCommand: (_event: Event, context: MenuContext = {}) =>
            void getMeta({
              win,
              items: context.items,
              collectionID: getSelectedCollectionID(win),
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

  const itemContextMenu = findItemContextMenu(doc);
  if (!itemContextMenu) {
    ztoolkit.log("Zotero item context menu was not found.");
    return;
  }

  const menuItem = createMenuItem(doc);
  menuItem.setAttribute("id", MENU_ID);
  menuItem.setAttribute("label", getString("itemmenu-updateMetadata-label"));
  menuItem.setAttribute("class", "menuitem-iconic");
  menuItem.setAttribute("image", menuIcon);
  menuItem.addEventListener(
    "command",
    () =>
      void getMeta({
        win,
        collectionID: getSelectedCollectionID(win),
      }),
  );

  itemContextMenu.append(menuItem);
  registeredMenuItem = menuItem;
  updateMenuDisabledState(win);
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
  const menuItem = context?.menuElem ?? win.document.getElementById(MENU_ID);

  context?.setVisible?.(true);
  context?.setEnabled?.(enabled);

  if (enabled) {
    menuItem?.removeAttribute("disabled");
    return;
  }

  menuItem?.setAttribute("disabled", "true");
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

  registeredMenuItem?.remove();
  registeredMenuItem = null;
  win?.document.getElementById(MENU_ID)?.remove();

  if (selectionGuardTarget && selectionGuardListener) {
    selectionGuardTarget.removeEventListener(
      "contextmenu",
      selectionGuardListener,
    );
  }

  selectionGuardTarget = null;
  selectionGuardListener = null;
}
