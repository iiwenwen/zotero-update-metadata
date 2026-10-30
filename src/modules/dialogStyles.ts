// DialogHelper 5.2.0 提供宿主样式与按钮；这里只约束内容区及使用系统语义颜色。
// 不覆盖 button/input 的外观、字号、焦点或禁用状态。
export const DIALOG_STYLES = `
  .zmta-dialog-window {
    color-scheme: light dark;
    --zmta-window: Canvas;
    --zmta-sidebar: Field;
    --zmta-panel: Field;
    --zmta-line: ButtonBorder;
    --zmta-text: CanvasText;
    /* GrayText是禁用系统色；正常说明复用宿主次要文本，缺失时回退正文色。 */
    --zmta-muted: var(--fill-secondary, var(--zmta-text, CanvasText));
    --zmta-warning: CanvasText;
    --zmta-notice: Field;
  }
  .zmta-dialog-window body { margin: 0; padding: 0; height: 100vh; overflow: hidden; }
  .zmta-dialog-window body > vbox { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .zmta-dialog-window body > vbox > hbox:first-child { display: flex; flex: 1; min-height: 0; }
  .zmta-dialog-window body > vbox > hbox:first-child > vbox { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
  .zmta-dialog-window body > vbox > hbox:last-child { display: flex; flex: none; flex-wrap: wrap; justify-content: flex-end; }
  .zmta-dialog-window .zmta-workflow { flex: 1; min-height: 0; box-sizing: border-box; overflow: auto; }
  .zmta-dialog-window .zmta-native-navigation { width: 100%; min-width: 0; max-width: 100%; }
  .zmta-dialog-window progress { width: 100%; }
`;

export function markDialogWindow(dialog: any): void {
  dialog.window?.document?.documentElement?.classList?.add("zmta-dialog-window");
}
