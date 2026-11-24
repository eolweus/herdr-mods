import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, exec, layout, theme } from "herdr";

// Written by ~/.claude/statusline-command.sh each time a Claude Code status line renders.
const CACHE = "$HOME/.cache/claude-usage.json";
const WINDOWS = [["five_hour", "5h"], ["seven_day", "Week"]];

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

const left = (secs) => {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.max(1, Math.floor((secs % 3600) / 60));
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

export default class Usage extends View {
  init(_props, cx) {
    this.data = null;
    if (checking()) return;
    const read = (cx) => cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", `cat "${CACHE}"`], { timeout: 5000 });
        this.data = JSON.parse(r.stdout);
      } catch {}
      cx.notify();
    });
    read(cx);
    cx.timer.every(30000, read);
  }

  render() {
    const t = theme();
    const narrow = (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
    const now = Date.now() / 1000;
    const rows = WINDOWS.flatMap(([key, label]) => {
      const w = this.data?.rate_limits?.[key];
      if (!w) return [];
      // Past its reset the window starts over, even if no status line has rendered since.
      const reset = w.resets_at && w.resets_at <= now;
      const pct = reset ? 0 : Math.max(0, Math.min(100, w.used_percentage ?? 0));
      return [{ label, pct, until: reset || !w.resets_at ? null : w.resets_at - now }];
    });
    if (!rows.length) return div().size_full().bg(t.chrome);
    const color = (p) => (p >= 90 ? t.blocked : p >= 70 ? t.working : t.accent);
    if (narrow) {
      return v_flex().size_full().bg(t.chrome).items_center().justify_end().pb(6).gap(2)
        .children(rows.map((r) => div().text_size(10.5).font_semibold().text_color(color(r.pct)).child(`${Math.round(r.pct)}%`)));
    }
    const stale = this.data?.at && now - this.data.at > 6 * 3600;
    return v_flex().size_full().bg(t.chrome).justify_end().px(16).pb(10).gap(7)
      .child(h_flex().justify_between().text_size(11).text_color(t.dim)
        .child("Claude usage")
        .when(Boolean(stale), (el) => el.child(`as of ${left(now - this.data.at)} ago`)))
      .children(rows.map((r) => v_flex().gap(4)
        .child(h_flex().justify_between().items_center().text_size(11.5)
          .child(div().text_color(t.muted).child(r.label))
          .child(h_flex().gap(6)
            .when(r.until != null, (el) => el.child(div().text_color(t.dim).child(`resets in ${left(r.until)}`)))
            .child(div().font_semibold().text_color(t.foreground).child(`${Math.round(r.pct)}%`))))
        .child(div().h(5).w_full().rounded(3).bg(t.border)
          .child(div().h_full().w(`${r.pct}%`).rounded(3).bg(color(r.pct))))));
  }
}
