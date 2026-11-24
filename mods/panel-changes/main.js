import { View, div } from "gpui-kit";
import { checking, closeOverlay, focused, layout, panes, props, run } from "herdr";

const find = (node, id) => {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
};

export default class PanelChanges extends View {
  init() {
    if (checking()) return;
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (panel && !panel.hidden && body?.active === "changes") {
      run("layout.hide", { id: "panel" });
      // The pane keeps Herdr's focus but not the keyboard; a mod pane takes it back on "focus".
      const mod = panes().find((p) => p.pane === focused()?.pane)?.mod;
      if (mod) run(`${mod}.focus`);
    } else if (panel) {
      run("layout.select", { stack: "panel-body", child: "changes" });
      run("layout.show", { id: "panel" });
    }
    closeOverlay(props().overlay);
  }

  render() {
    return div();
  }
}
