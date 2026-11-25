import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, nextCommand, notify, panes, run, spaces, theme } from "herdr";
import { Preview } from "./preview.js";

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const claimed = (globalThis[Symbol.for("files-work.panes")] ??= new Set());

export class FileTab {
  constructor(p, cx) {
    this.path = p.path;
    this.on = p.machine ?? null;
    this.line = p.line ?? null;
    this.preview = new Preview(this.path, this.on, cx, this.line);
    // A mod pane isn't told its id; a new tab is focused, so the focused unclaimed files-work pane is this one.
    cx.timer.every(300, () => {
      // Focusing the editor scrolls the selected line into view.
      if (this.preview.jump && this.preview.code) { this.preview.jump = false; this.preview.code.focus(); }
      if (this.pane && panes().some((x) => x.pane === this.pane)) return;
      const f = panes().find((x) => x.focused && x.mod === "files-work" && !claimed.has(x.pane));
      if (!f) return;
      claimed.add((this.pane = f.pane));
      if (!f.name) run("pane.rename", { pane: f.pane, name: this.path.split("/").pop() });
    });
    cx.spawn(async () => {
      for (;;) if ((await nextCommand()) === "nvim" && this.pane && focused()?.pane === this.pane) this.nvim();
    });
  }

  me() {
    return panes().find((x) => x.pane === (this.pane ?? focused()?.pane) && x.mod === "files-work") ?? null;
  }

  nvim() {
    const me = this.me();
    if (!me) return;
    const space = spaces().find((s) => s.tabs.some((t) => t.id === me.tab));
    const there = space?.machine ?? null;
    let argv;
    if (there === this.on) argv = ["sh", "-c", 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; cd "$1" 2>/dev/null; shift; exec "${EDITOR:-nvim}" "$@"', "sh", this.path.replace(/\/[^/]*$/, "") || "/", ...(this.line ? [`+${this.line}`] : []), this.path];
    else if (this.on && !there) argv = ["ssh", "-t", this.on, `cd ${quote(this.path.replace(/\/[^/]*$/, "") || "/")} 2>/dev/null; exec "\${EDITOR:-nvim}" ${this.line ? `+${this.line} ` : ""}${quote(this.path)}`];
    else return notify({ title: "Can't open nvim here", body: `This tab is on ${there}, the file on ${this.on ?? "this computer"}`, level: "error" });
    const mine = panes().filter((x) => x.tab === me.tab);
    if (mine.length === 1) {
      run("pane.split", { pane: me.pane, direction: "right", argv });
      run("pane.close", { pane: me.pane });
      return;
    }
    // Splitting this pane and closing it would leave nvim a quarter of the space; split a neighbour instead.
    const at = mine.findIndex((x) => x.pane === me.pane), source = (mine[at - 1] ?? mine[at + 1]).pane;
    run("pane.close", { pane: me.pane });
    run("pane.focus", { pane: source });
    run("pane.split", { pane: source, direction: "right", argv });
  }

  render() {
    const t = theme(), p = this.preview;
    const name = this.path.split("/").pop(), dir = this.path.slice(0, -name.length - 1);
    const button = (id, label, tip, click) => h_flex().id(id).flex_none().h(24).px(8).items_center().rounded(6).border_1().border_color(t.border)
      .cursor_pointer().text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(click).child(label);
    return v_flex().id("file-tab").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/files-work/file.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().font_semibold().child(this.line ? `${name}:${this.line}` : name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${this.on ? `${this.on}:` : ""}${dir}`))
        .when(p.kind === "pdf" && Boolean(p.pages?.length), (el) => el
          .child(button("zoom-out", "−", "Zoom out", (_e, cx) => { p.zoom = Math.max(0.25, p.zoom / 1.25); cx.notify(); }))
          .child(div().w(40).text_center().text_size(12).text_color(t.dim).child(`${Math.round(p.zoom * 100)}%`))
          .child(button("zoom-in", "+", "Zoom in", (_e, cx) => { p.zoom = Math.min(6, p.zoom * 1.25); cx.notify(); })))
        .when(p.markdown && Boolean(p.code), (el) => el.child(button("source", p.rendered ? "Source" : "Reader",
          p.rendered ? "Show the Markdown source" : "Show it rendered", (_e, cx) => { p.rendered = !p.rendered; cx.notify(); })))
        .child(button("outside", "Open", "Open in its default app", () => p.openOutside().catch((e) => notify({ title: "Couldn't open the file", body: String(e?.message ?? e), level: "error" }))))
        .child(button("nvim", "nvim", "Replace this tab with nvim", () => this.nvim())))
      .child(p.body(t));
  }

  close() {
    claimed.delete(this.pane);
    this.preview.release();
  }
}
