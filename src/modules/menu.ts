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

export function registerMenu() {
  const menuIcon = `chrome://${config.addonRef}/content/icons/favicon.png`;
  const menuManager = (Zotero as unknown as { MenuManager?: MenuManager })
    .MenuManager;

  unregisterMenu();

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
            updateMenuDisabledState(context);
          },
          onCommand: () => void getMeta(),
        },
      ],
    });

    if (registered) {
      registeredMenuKey = registered;
      return;
    }

    ztoolkit.log("Zotero MenuManager rejected item context menu.");
  }

  registerFallbackMenu(menuIcon);
}

function registerFallbackMenu(menuIcon: string) {
  const doc = window.document;
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
  menuItem.addEventListener("command", () => void getMeta());

  itemContextMenu.append(menuItem);
  registeredMenuItem = menuItem;
  updateMenuDisabledState();
}

function getRegularItems(context?: MenuContext) {
  const items = context?.items ?? ZoteroPane.getSelectedItems();
  return items.filter(isRegularZoteroItem);
}

function canUpdateSelectedItems(context?: MenuContext) {
  const selectedItems = context?.items ?? ZoteroPane.getSelectedItems();
  const items = getRegularItems(context);
  return (
    items.length > 0
    && items.length === selectedItems.length
    && items.every((item) => isSupportedMetadataURL(item.getField("url")))
  );
}

function updateMenuDisabledState(context?: MenuContext) {
  const enabled = canUpdateSelectedItems(context);
  const menuItem = context?.menuElem ?? document.getElementById(MENU_ID);

  context?.setVisible?.(true);
  context?.setEnabled?.(enabled);

  if (enabled) {
    menuItem?.removeAttribute("disabled");
    return;
  }

  menuItem?.setAttribute("disabled", "true");
}

export async function selectoritem() {
  if (registeredMenuKey) {
    return;
  }

  if (selectionGuardTarget && selectionGuardListener) {
    return;
  }

  const itemsTreeElement = document.getElementById("zotero-items-tree");
  if (!itemsTreeElement) {
    ztoolkit.log("Zotero items tree was not found.");
    return;
  }

  selectionGuardListener = () => updateMenuDisabledState();
  selectionGuardTarget = itemsTreeElement;
  itemsTreeElement.addEventListener("contextmenu", selectionGuardListener);
}

export function unregisterMenu() {
  if (registeredMenuKey) {
    (Zotero as unknown as { MenuManager?: MenuManager }).MenuManager
      ?.unregisterMenu?.(registeredMenuKey);
    registeredMenuKey = null;
  }

  registeredMenuItem?.remove();
  registeredMenuItem = null;
  document.getElementById(MENU_ID)?.remove();

  if (selectionGuardTarget && selectionGuardListener) {
    selectionGuardTarget.removeEventListener(
      "contextmenu",
      selectionGuardListener,
    );
  }

  selectionGuardTarget = null;
  selectionGuardListener = null;
}
