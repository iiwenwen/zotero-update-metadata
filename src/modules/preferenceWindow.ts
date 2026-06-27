import { config, homepage } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";

export function registerPrefsWindow() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: getString("pref-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
    helpURL: homepage,
  });
}

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [],
      rows: [],
    };
  } else {
    addon.data.prefs.window = _window;
  }
  updatePrefsUI();
  bindPrefEvents();
}

async function updatePrefsUI() {
  // disablePrefs();
}

function bindPrefEvents() {
  const doc = addon.data.prefs!.window?.document;
  if (!doc) {
    return;
  }

  bindPrefCheckbox(doc, "saveAttachments");
  bindPrefCheckbox(doc, "confirmBeforeUpdate");
  bindPrefCheckbox(doc, "saveNotes");

  ztoolkit.UI.replaceElement(
    {
      tag: "menulist",
      attributes: {
        value: getPref("schema") as string,
        native: "true",
      },
      listeners: [
        {
          type: "command",
          listener: (e: Event) => {
            if (e.target) {
              const target = e.target as HTMLInputElement;
              setPref("schema", target.value);
              ztoolkit.log("schema", target.value);
            }
          },
        },
      ],
      children: [
        {
          tag: "menupopup",
          children: [
            {
              tag: "menuitem",
              attributes: {
                label: getString("schema-saveItem"),
                value: "save",
              },
            },
            {
              tag: "menuitem",
              attributes: {
                label: getString("schema-updateItem"),
                value: "update",
              },
            },
          ],
        },
      ],
    },
    doc.querySelector(`#${makeId("select-schema")}`) as HTMLElement,
  );

  ztoolkit.UI.replaceElement(
    {
      tag: "menulist",
      attributes: {
        value: (getPref("attachmentSaveStrategy") as string) || "missing",
        native: "true",
      },
      listeners: [
        {
          type: "command",
          listener: (e: Event) => {
            if (e.target) {
              const target = e.target as HTMLInputElement;
              setPref("attachmentSaveStrategy", target.value);
              ztoolkit.log("attachmentSaveStrategy", target.value);
            }
          },
        },
      ],
      children: [
        {
          tag: "menupopup",
          children: [
            {
              tag: "menuitem",
              attributes: {
                label: getString("attachmentStrategy-none"),
                value: "none",
              },
            },
            {
              tag: "menuitem",
              attributes: {
                label: getString("attachmentStrategy-missing"),
                value: "missing",
              },
            },
            {
              tag: "menuitem",
              attributes: {
                label: getString("attachmentStrategy-always"),
                value: "always",
              },
            },
          ],
        },
      ],
    },
    doc.querySelector(`#${makeId("attachment-strategy")}`) as HTMLElement,
  );
}

function bindPrefCheckbox(doc: Document, prefKey: string) {
  const checkbox = doc.querySelector(`#${makeId(prefKey)}`) as
    | (HTMLInputElement & { checked?: boolean })
    | null;

  if (!checkbox) {
    return;
  }

  checkbox.checked = getPref(prefKey) === true || getPref(prefKey) === "true";

  const saveCheckedState = () => {
    setPref(prefKey, checkbox.checked === true);
    ztoolkit.log(prefKey, checkbox.checked);
  };

  checkbox.addEventListener("command", saveCheckedState);
  checkbox.addEventListener("change", saveCheckedState);
}
// function disablePrefs() {
//   const state = getPref("saveAttachments");
//   ztoolkit.log("saveAttachments", state);
//   // const doc = addon.data.prefs.window?.document;
//   // const elemValue = fromElement?(doc.querySelector(`${config.addonRef}-saveAttachments`)as XUL.Checkbox).checked:getPref("saveAttachments")as boolean);
//   // doc
//   //   .querySelector(`${config.addonRef}-saveAttachments`)
//   //   ?.addEventListener("command", (ev) => {
//   //     ztoolkit.log("saveAttachments", state);
//   //   });
// }

function makeId(type: string) {
  return `${config.addonRef}-${type}`;
}

function onPrefsEvents(type: string, fromElement: boolean = true) {
  const doc = addon.data.prefs?.window.document;
  if (!doc) {
    return;
  }
}
