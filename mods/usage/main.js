import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, exec, layout, theme } from "herdr";

// Written by ~/.claude/statusline-command.sh each time a Claude Code status line renders.
const CLAUDE = "$HOME/.cache/claude-usage.json";
// Written by the herdr-chat engine from `agy -p /usage` every few minutes.
const GEMINI = "$HOME/.cache/gemini-usage.json";
const WINDOWS = [["five_hour", "5h"], ["seven_day", "Week"]];
const GEMINI_WINDOWS = { "5h": "5h", weekly: "Week" };

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

// Past its reset a window starts over, even if nothing has written the cache since.
function row(label, used, resets, now) {
  const reset = resets && resets <= now;
  const pct = reset ? 0 : Math.max(0, Math.min(100, used ?? 0));
  return { label, pct, until: reset || !resets ? null : resets - now };
}

async function readJson(path) {
  try {
    const r = await exec("sh", ["-c", `cat "${path}"`], { timeout: 5000 });
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export default class Usage extends View {
  init(_props, cx) {
    this.claude = null;
    this.gemini = null;
    if (checking()) return;
    const read = (cx) => cx.spawn(async (cx) => {
      this.claude = (await readJson(CLAUDE)) ?? this.claude;
      this.gemini = (await readJson(GEMINI)) ?? this.gemini;
      cx.notify();
    });
    read(cx);
    cx.timer.every(30000, read);
  }

  sections(now) {
    const out = [];
    const claude = WINDOWS.flatMap(([key, label]) => {
      const w = this.claude?.rate_limits?.[key];
      return w ? [row(label, w.used_percentage, w.resets_at, now)] : [];
    });
    if (claude.length) out.push({ title: "Claude usage", at: this.claude.at, rows: claude });
    // Antigravity groups models under shared limits; a group nobody has used has no reset time.
    const groups = (this.gemini?.groups ?? []).filter((g) => g.windows?.some((w) => w.resets_at || w.used_percentage));
    const gemini = groups.flatMap((g) => g.windows.map((w) => row(
      `${groups.length > 1 ? `${g.name.replace(/ models$/i, "")} · ` : ""}${GEMINI_WINDOWS[w.window] ?? w.window}`, w.used_percentage, w.resets_at, now)));
    if (gemini.length) out.push({ title: "Antigravity usage", at: this.gemini.at, rows: gemini });
    return out;
  }

  render() {
    const t = theme();
    const narrow = (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
    const now = Date.now() / 1000;
    const sections = this.sections(now);
    if (!sections.length) return div().size_full().bg(t.chrome);
    const color = (p) => (p >= 90 ? t.blocked : p >= 70 ? t.working : t.accent);
    if (narrow) {
      return v_flex().size_full().bg(t.chrome).items_center().justify_end().pb(6).gap(2)
        .children(sections.flatMap((s) => s.rows).map((r) => div().text_size(10.5).font_semibold().text_color(color(r.pct)).child(`${Math.round(r.pct)}%`)));
    }
    return v_flex().size_full().bg(t.chrome).justify_end().px(16).pb(10).gap(12)
      .children(sections.map((s) => {
        const stale = s.at && now - s.at > 6 * 3600;
        return v_flex().gap(7)
          .child(h_flex().justify_between().text_size(11).text_color(t.dim)
            .child(s.title)
            .when(Boolean(stale), (el) => el.child(`as of ${left(now - s.at)} ago`)))
          .children(s.rows.map((r) => v_flex().gap(4)
            .child(h_flex().justify_between().items_center().text_size(11.5)
              .child(div().text_color(t.muted).child(r.label))
              .child(h_flex().gap(6)
                .when(r.until != null, (el) => el.child(div().text_color(t.dim).child(`resets in ${left(r.until)}`)))
                .child(div().font_semibold().text_color(t.foreground).child(`${Math.round(r.pct)}%`))))
            .child(div().h(5).w_full().rounded(3).bg(t.border)
              .child(div().h_full().w(`${r.pct}%`).rounded(3).bg(color(r.pct))))));
      }));
  }
}
