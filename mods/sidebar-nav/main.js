import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, layout, panes, run, shared, theme } from "herdr";

const VIEWS = [["needs-view", "Needs you", "bell"], ["machines-view", "Machines", "server"], ["scheduler-view", "Scheduler", "clock"], ["artifacts-view", "Artifacts", "layers"], ["plugins-view", "Plugins", "puzzle"]];

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

// Chats publish their status to shared state; terminals report theirs; handoffs run without a pane.
function waiting() {
  const ps = panes().filter((p) => (p.mod === "herdr-chat" ? shared(`herdr-chat:pane:${p.pane}`)?.status : p.terminal ? p.status : null) === "blocked").length;
  return ps + (shared("handoffs") ?? []).filter((h) => h.status === "blocked").length;
}

const show = (id) => run("layout.select", { stack: "work-stack", child: id });

export default class SidebarNav extends View {
  init(_props, cx) {
    cx.timer.every(1000, (cx) => cx.notify());
  }

  render() {
    const t = theme();
    const root = layout();
    const active = find(root, "work-stack")?.active ?? "work";
    const narrow = (find(root, "sidebar")?.size?.px ?? Infinity) < 160;
    // Picking a space, tab or agent elsewhere means the person wants their terminals back.
    const where = `${focused()?.space}/${focused()?.tab}/${focused()?.pane}`;
    if (this.where !== undefined && where !== this.where && active !== "work") show("work");
    this.where = where;

    const count = waiting();
    return v_flex().size_full().px(8).pt(8).gap(3).bg(t.chrome)
      .children(VIEWS.map(([id, label, icon]) => {
        const on = id === active;
        return h_flex().id(`nav-${id}`).h(36).px(narrow ? 0 : 10).gap(11).items_center().rounded(8).cursor_pointer()
          .when(narrow, (el) => el.justify_center())
          .text_size(14.5).text_color(on ? t.foreground : t.muted)
          .when(on, (el) => el.bg(t.selected))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click(() => show(on ? "work" : id))
          .child(svg(`mods/sidebar-nav/${icon}.svg`).size(18))
          .when(!narrow, (el) => el.child(div().flex_1().child(label)))
          .when(id === "needs-view" && count > 0 && !narrow, (el) => el.child(div().flex_none().min_w(18).h(18).px(5).rounded(9).bg(t.blocked)
            .text_size(11).font_semibold().text_color(t.background).flex().items_center().justify_center().child(String(count))));
      }));
  }
}
