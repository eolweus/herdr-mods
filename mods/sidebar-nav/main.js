import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, layout, run, theme } from "herdr";

const VIEWS = [["machines-view", "Machines", "server"], ["scheduler-view", "Scheduler", "clock"], ["artifacts-view", "Artifacts", "layers"], ["plugins-view", "Plugins", "puzzle"]];

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

const show = (id) => run("layout.select", { stack: "work-stack", child: id });

export default class SidebarNav extends View {
  render() {
    const t = theme();
    const root = layout();
    const active = find(root, "work-stack")?.active ?? "work";
    const narrow = (find(root, "sidebar")?.size?.px ?? Infinity) < 160;
    // Picking a space, tab or agent elsewhere means the person wants their terminals back.
    const where = `${focused()?.space}/${focused()?.tab}/${focused()?.pane}`;
    if (this.where !== undefined && where !== this.where && active !== "work") show("work");
    this.where = where;

    return v_flex().size_full().px(8).pt(6).gap(2).bg(t.chrome)
      .children(VIEWS.map(([id, label, icon]) => {
        const on = id === active;
        return h_flex().id(`nav-${id}`).h(32).px(narrow ? 0 : 10).gap(10).items_center().rounded(8).cursor_pointer()
          .when(narrow, (el) => el.justify_center())
          .text_size(13.5).text_color(on ? t.foreground : t.muted)
          .when(on, (el) => el.bg(t.selected))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click(() => show(on ? "work" : id))
          .child(svg(`mods/sidebar-nav/${icon}.svg`).size(16))
          .when(!narrow, (el) => el.child(label));
      }));
  }
}
