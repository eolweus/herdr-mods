// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-work" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, shared } from "herdr";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-work/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    // Chat panes aren't terminals, so they report their folder and status through shared state.
    const chat = p.mod === "herdr-chat" ? shared(`herdr-chat:pane:${p.pane}`) ?? {} : null;
    const agy = chat?.backend === "agy";
    const name = chat ? (agy ? "Antigravity" : "Claude") : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = agy ? image("icons/antigravity.svg").size(14).flex_none() : chat ? svg("icons/claude.svg").size(14).flex_none().text_color(t.accent) : icon(p.program, 14, t.dim);
    const st = chat ? chat.status : p.status;
    // Claude Code puts its session name in the terminal title.
    const session = chat ? chat.title : p.program?.agent && p.title && p.title !== p.program.name ? p.title.replace(/^[^\p{L}\p{N}]+/u, "") : null;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    // A handoff's chat opens in the sender's space but runs on its own machine.
    const info = chat && shared(`herdr-chat:info:${pane}`);
    const machine = info ? info.machine ?? null : pane.includes("/") ? pane.split("/")[0] : null;
    const mc = (shared("machine.colors") ?? {})[machine ?? "local"];
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(mc ? mc + "88" : t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .when(Boolean(session), el => el.child(div().flex_initial().min_w(40).truncate().text_color(t.muted).child(session)))
      .child(div().flex_1().truncate().text_color(t.dim).child(chat ? chat.folder ?? "" : folder(p.cwd)))
      .when(Boolean(mc), el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(mc + "26").text_size(10.5).font_semibold().text_color(mc).child(machine ?? "this computer")))
      .when(p.zoomed, el => el.child(h_flex().id(`ph-zoomed-${pane}`).flex_none().px(6).h(18).gap(4).items_center().rounded(5)
        .bg(t.accent + "26").text_size(10.5).font_semibold().text_color(t.accent).cursor_pointer().hover(s => s.bg(t.accent + "40"))
        .tooltip("Other panes in this tab are hidden. Click to show them").on_click((_e, cx) => { cx.stop_propagation(); run("pane.zoom", { pane }); })
        .child(svg("mods/pane-work/zoom.svg").size(11)).child("Zoomed")))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
