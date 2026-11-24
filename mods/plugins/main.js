import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, checking, exec, layout, layouts, machines, notify, run, shared, theme } from "herdr";
import * as fs from "fs/promises";
import { Buffer } from "buffer";

// Mod exec and remote shells start without the user's PATH.
const HERDR = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" herdr';
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const SHOTS = "data/plugins/shots";
// Where a plugin repo keeps its gallery picture, first match wins.
const SHOT_PATHS = ["docs/screenshot.png", "docs/assets/screenshot.png", "screenshot.png"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

const shown = () => find(layout(), "work-stack")?.active === "plugins-view";

// The layout parts a person can hide: each mod block, or for one inside a stack the nearest part holding that stack.
// Parts holding the terminals, and the nav that leads back here, stay.
function parts(root) {
  const out = new Map();
  const has = (n, pred) => pred(n) || (n.children ?? []).some((c) => has(c, pred));
  const holdsTabs = (n) => has(n, (x) => x.content?.tab);
  const walk = (n, path) => {
    const mod = n.content?.mod;
    if (mod) {
      let i = path.length;
      let target = n;
      while (i > 0 && path[i - 1].type === "stack") { target = path[i - 2]; i -= 2; }
      if (target && target.id && target !== root && !holdsTabs(target) && mod !== "sidebar-nav") {
        const p = out.get(target.id) ?? { id: target.id, hidden: Boolean(target.hidden), mods: [] };
        if (!p.mods.includes(mod)) p.mods.push(mod);
        out.set(target.id, p);
      }
    }
    for (const c of n.children ?? []) walk(c, [...path, n]);
  };
  if (root) walk(root, []);
  return [...out.values()];
}

const usedIn = (root) => {
  const s = new Set();
  const walk = (n) => { if (n?.content?.mod) s.add(n.content.mod); (n?.children ?? []).forEach(walk); };
  walk(root);
  return s;
};

const LIST_MODS = `cd "$1"; for dir in mods mods-disabled; do [ -d "$dir" ] || continue; for m in "$dir"/*; do [ -d "$m" ] || continue; n=$(basename "$m"); printf '%s\\t%s\\t%s\\t' "$dir" "$n" "$(readlink "$m")"; [ -f "$m/screenshot.png" ] && printf 1; printf '\\t'; tr -d '\\n\\t' < "$m/mod.json" 2>/dev/null; printf '\\t'; grep -rlF --include='*.js' --include='*.json' "\\"$n\\"" mods/*/ keys.json 2>/dev/null | grep -v "^mods/$n/" | sed 's|^mods/||; s|/.*||' | sort -u | tr '\\n' ' '; echo; done; done; echo ---; cat installed.json; echo; echo ---; ls layouts-disabled 2>/dev/null`;

const READ_SHOT = `for f in ${SHOT_PATHS.join(" ")}; do [ -f "$1/$f" ] && exec base64 < "$1/$f"; done; exit 1`;

const tilde = (p) => p?.replace(/^\/(Users|home)\/[^/]+/, "~");

export default class Plugins extends View {
  init() {
    this.mods = [];
    this.builtin = new Set();
    this.disabledLayouts = [];
    this.plugins = {};
    this.pluginErrors = {};
    this.shots = {};
    this.shotTried = new Set();
    this.perMachine = new Set();
    this.busy = new Set();
    this.folded = new Set(["builtin", "parts"]);
    this.wasShown = false;
  }

  async loadLocal() {
    const r = await exec("sh", ["-c", LIST_MODS, "sh", appHome()]);
    const [modsPart, installedPart, disabledPart] = r.stdout.split("\n---\n");
    try { this.builtin = new Set(Object.keys(JSON.parse(installedPart.trim() || "{}"))); } catch { this.builtin = new Set(); }
    this.disabledLayouts = (disabledPart ?? "").split("\n").map((s) => s.trim()).filter((s) => s.endsWith(".json")).map((s) => s.slice(0, -5));
    this.mods = modsPart.split("\n").filter(Boolean).map((line) => {
      const [dir, name, link, shot, manifest, users] = line.split("\t");
      let m = {};
      try { m = JSON.parse(manifest || "{}"); } catch {}
      return { name, link: link || null, shot: shot === "1", title: m.title ?? null, description: m.description ?? null, enabled: dir === "mods", users: (users ?? "").trim().split(" ").filter((u) => u && u !== name) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadPlugins(m, cx) {
    const k = m.name ?? "";
    try {
      const r = await exec("sh", ["-c", `${HERDR} plugin list --json`], { on: m.name, timeout: 15000 });
      this.plugins[k] = JSON.parse(r.stdout).result.plugins.map((p) => ({ id: p.plugin_id, name: p.name, description: p.description, enabled: p.enabled, version: p.version, root: p.plugin_root, source: p.source?.kind === "github" ? "GitHub" : p.source?.kind === "local" ? tilde(p.plugin_root) : p.source?.kind }));
      delete this.pluginErrors[k];
    } catch (e) {
      this.pluginErrors[k] = String(e?.message ?? e).split("\n")[0];
    }
    cx.notify();
    for (const p of this.plugins[k] ?? []) {
      const tried = `${k}:${p.id}`;
      if (this.shots[p.id] || this.shotTried.has(tried)) continue;
      this.shotTried.add(tried);
      await this.loadShot(m, p).catch(() => {});
    }
    cx.notify();
  }

  // Plugins live on their machine; the picture is copied here so image() can read it.
  async loadShot(m, p) {
    const r = await exec("sh", ["-c", READ_SHOT, "sh", p.root], { on: m.name, timeout: 15000 }).catch(() => null);
    if (!r || r.code !== 0) return;
    const rel = `${SHOTS}/${p.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.png`;
    await fs.mkdir(`${appHome()}/${SHOTS}`, { recursive: true }).catch(() => {});
    await fs.writeFile(`${appHome()}/${rel}`, Buffer.from(r.stdout.replace(/\s/g, ""), "base64"));
    this.shots[p.id] = rel;
  }

  refresh(cx) {
    cx.spawn(async (cx) => { await this.loadLocal().catch((e) => notify({ title: "Couldn't list mods", body: String(e), level: "error" })); cx.notify(); });
    for (const m of machines()) this.loadMachine(m, cx);
  }

  loadMachine(m, cx) {
    const k = `machine:${m.name ?? ""}`;
    if (m.layout !== "ready" || m.temporary || this.busy.has(k)) return;
    this.busy.add(k);
    cx.spawn(async (cx) => { await this.loadPlugins(m, cx); this.busy.delete(k); cx.notify(); });
  }

  async act(key, work, cx) {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    cx.notify();
    try { await work(); } catch (e) { notify({ title: "That didn't work", body: String(e?.message ?? e), level: "error" }); }
    this.busy.delete(key);
    cx.notify();
  }

  togglePlugin(m, p, cx, want = !p.enabled) {
    cx.spawn(async (cx) => this.act(`plugin:${m.name}:${p.id}`, async () => {
      const r = await exec("sh", ["-c", `${HERDR} plugin ${want ? "enable" : "disable"} ${q(p.id)}`], { on: m.name, timeout: 30000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim());
      await this.loadPlugins(m, cx);
    }, cx));
  }

  toggleMod(mod, cx) {
    const [from, to] = mod.enabled ? ["mods", "mods-disabled"] : ["mods-disabled", "mods"];
    cx.spawn(async (cx) => this.act(`mod:${mod.name}`, async () => {
      const r = await exec("sh", ["-c", `cd "$1" && mkdir -p ${to} && [ ! -e ${to}/"$2" ] && mv ${from}/"$2" ${to}/"$2"`, "sh", appHome(), mod.name]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `${to}/${mod.name} already exists`);
      await this.loadLocal();
    }, cx));
  }

  toggleLayout(name, enabled, cx) {
    const [from, to] = enabled ? ["layouts", "layouts-disabled"] : ["layouts-disabled", "layouts"];
    cx.spawn(async (cx) => this.act(`layout:${name}`, async () => {
      const r = await exec("sh", ["-c", `cd "$1" && mkdir -p ${to} && [ ! -e ${to}/"$2".json ] && mv ${from}/"$2".json ${to}/"$2".json`, "sh", appHome(), name]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `${to}/${name}.json already exists`);
      await this.loadLocal();
    }, cx));
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    cx.notify();
  }

  toggle(id, on, busy, tip, onClick, t) {
    return div().id(`toggle-${id}`).w(30).h(18).flex_none().rounded(9).p(2).flex().items_center()
      .bg(on ? t.accent : t.border)
      .when(!busy, (el) => el.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .when(busy, (el) => el.opacity(0.5))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(div().size(14).rounded(7).bg("#ffffff").when(on, (el) => el.ml(12)));
  }

  badge(text, t, color) {
    return div().max_w(270).truncate().px(6).py(1).rounded(5).bg(t.background).border_1().border_color(t.border).text_size(10.5).text_color(color ?? t.dim).flex_none().child(text);
  }

  row(id, title, detail, right, t) {
    return h_flex().id(`row-${id}`).gap(12).px(12).py(8).items_center().rounded(8).hover((s) => s.bg(t.hover))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(8).items_center().min_w(0).children(title))
        .when(Boolean(detail), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(detail))))
      .children(right);
  }

  heading(id, title, extra, t) {
    const open = !this.folded.has(id);
    return h_flex().id(`fold-${id}`).gap(8).items_center().px(4).cursor_pointer().on_click((_e, cx) => this.fold(id, cx))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).text_color(t.dim))
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
      .when(extra != null, (el) => el.child(div().text_size(12).text_color(t.dim).child(extra)));
  }

  section(id, title, extra, rows, t) {
    const open = !this.folded.has(id);
    return v_flex().gap(4).p(16).rounded(12).bg(t.surface).border_1().border_color(t.border)
      .child(this.heading(id, title, extra, t))
      .when(open, (el) => el.child(div().h(4)).children(rows));
  }

  gallery(id, title, extra, cards, t) {
    return v_flex().gap(12)
      .child(this.heading(id, title, extra, t))
      .when(!this.folded.has(id), (el) => el.child(h_flex().flex_wrap().items_start().gap(14).children(cards)));
  }

  card(id, { shot, title, sub, description, badges, toggle, footer, dim }, t) {
    const picture = div().h(168).w_full().flex_none().bg(t.background).border_b_1().border_color(t.border).overflow_hidden()
      .flex().items_center().justify_center()
      .child(shot ? image(shot).w_full().h(168) : div().text_size(32).font_semibold().text_color(t.border).child(title.slice(0, 1).toUpperCase()));
    return v_flex().id(`card-${id}`).w(300).flex_none().rounded(12).bg(t.surface).border_1().border_color(t.border).overflow_hidden()
      .when(dim, (el) => el.opacity(0.6))
      .child(picture)
      .child(v_flex().gap(6).p(14)
        .child(h_flex().gap(8).items_center()
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(14).font_semibold().text_color(t.foreground).truncate().child(title))
            .when(Boolean(sub), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(sub))))
          .when(Boolean(toggle), (el) => el.child(toggle)))
        .when(Boolean(description), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(description)))
        .when(badges?.length > 0, (el) => el.child(h_flex().flex_wrap().gap(5).pt(2).children(badges)))
        .when(Boolean(footer), (el) => el.child(footer)));
  }

  modCards(t) {
    const used = usedIn(layout());
    const mine = this.mods.filter((m) => !this.builtin.has(m.name));
    const cards = mine.map((mod) => {
      const inLayout = used.has(mod.name);
      const where = mod.link ? tilde(mod.link.replace(/\/mods?(\/[^/]+)?$/, "")) : null;
      const badges = [];
      if (inLayout) badges.push(this.badge("in this layout", t, t.accent));
      if (!mod.enabled) badges.push(this.badge("off: in mods-disabled", t));
      if (mod.users.length) badges.push(this.badge(`used by ${mod.users.join(", ")}`, t));
      const toggle = inLayout && mod.enabled
        ? this.toggle(`mod-${mod.name}`, true, true, "Hide its part of the layout below instead", () => {}, t)
        : this.toggle(`mod-${mod.name}`, mod.enabled, this.busy.has(`mod:${mod.name}`), mod.enabled ? "Turn it off" : "Turn it on", (cx) => this.toggleMod(mod, cx), t);
      return this.card(`mod-${mod.name}`, {
        shot: mod.shot ? `${mod.enabled ? "mods" : "mods-disabled"}/${mod.name}/screenshot.png` : null,
        title: mod.title ?? mod.name, sub: [mod.name, where].filter(Boolean).join(" · "),
        description: mod.description, badges, toggle, dim: !mod.enabled,
      }, t);
    });
    return this.gallery("mine", "Your mods", `${mine.filter((m) => m.enabled).length} of ${mine.length} on`, cards, t);
  }

  pluginCards(t) {
    const list = machines().filter((m) => !m.temporary);
    const byId = new Map();
    for (const m of list) for (const p of this.plugins[m.name ?? ""] ?? []) {
      const e = byId.get(p.id) ?? { ...p, on: [] };
      e.on.push({ m, p });
      byId.set(p.id, e);
    }
    const cards = [...byId.values()].map((e) => {
      const label = ({ m }) => m.name ?? "This computer";
      const row = (text, color, toggle) => h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(color).child(text)).child(toggle);
      const machineRow = ({ m, p }) => row(label({ m }), p.enabled ? t.foreground : t.dim,
        this.toggle(`plugin-${m.name ?? ""}-${p.id}`, p.enabled, this.busy.has(`plugin:${m.name}:${p.id}`), p.enabled ? "Disable it here" : "Enable it here", (cx) => this.togglePlugin(m, p, cx), t));
      const onFor = e.on.filter(({ p }) => p.enabled);
      const allOn = onFor.length === e.on.length;
      const open = this.perMachine.has(e.id);
      const busy = e.on.some(({ m, p }) => this.busy.has(`plugin:${m.name}:${p.id}`));
      const summary = allOn ? "All machines" : onFor.length ? `Only on ${onFor.map(label).join(", ")}` : "Off everywhere";
      const footer = e.on.length === 1
        ? v_flex().pt(6).border_t_1().border_color(t.border).child(machineRow(e.on[0]))
        : v_flex().gap(4).pt(6).border_t_1().border_color(t.border)
          .child(row(summary, onFor.length ? t.foreground : t.dim,
            this.toggle(`plugin-all-${e.id}`, allOn, busy, allOn ? "Disable it on every machine" : "Enable it on every machine",
              (cx) => { for (const x of e.on) if (x.p.enabled === allOn) this.togglePlugin(x.m, x.p, cx, !allOn); }, t)))
          .child(div().id(`per-machine-${e.id}`).text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { open ? this.perMachine.delete(e.id) : this.perMachine.add(e.id); cx.notify(); })
            .child(open ? "Hide machines" : "Per machine…"))
          .when(open, (el) => el.child(v_flex().gap(4).pl(10).children(e.on.map(machineRow))));
      return this.card(`plugin-${e.id}`, {
        shot: this.shots[e.id] ?? null, title: e.name, sub: [e.version, e.source].filter(Boolean).join(" · "),
        description: e.description, footer, dim: e.on.every(({ p }) => !p.enabled),
      }, t);
    });
    const waiting = list.filter((m) => m.layout !== "unavailable" && !this.plugins[m.name ?? ""] && !this.pluginErrors[m.name ?? ""]).map((m) => m.name ?? "this computer");
    const errors = list.filter((m) => this.pluginErrors[m.name ?? ""]).map((m) => `${m.name ?? "this computer"}: ${this.pluginErrors[m.name ?? ""]}`);
    const extra = [waiting.length ? `reading ${waiting.join(", ")}…` : null, ...errors].filter(Boolean).join(" · ") || "for terminal Herdr";
    return this.gallery("plugins", "Terminal Herdr plugins", extra, cards, t);
  }

  layoutsSection(t) {
    const current = shared("layout");
    const names = [...layouts().map((n) => ({ name: n, enabled: true })), ...this.disabledLayouts.map((n) => ({ name: n, enabled: false }))];
    const rows = names.map(({ name, enabled }) => {
      const builtin = this.builtin.has(`layout:${name}`);
      const active = name === current;
      const busy = this.busy.has(`layout:${name}`);
      const title = [div().text_size(13).font_medium().text_color(enabled ? t.foreground : t.dim).child(name)];
      if (active) title.push(div().text_size(11).text_color(t.accent).child("shown"));
      if (builtin) title.push(this.badge("built in", t));
      const right = [];
      if (enabled && !active) right.push(div().id(`switch-${name}`).px(10).py(3).rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.foreground).cursor_pointer()
        .hover((s) => s.bg(t.selected)).on_click(() => run("layout.switch", { name })).child("Show"));
      right.push(builtin || active
        ? this.toggle(`layout-${name}`, true, true, builtin ? "Herdr puts its own layouts back on every start" : "Switch to another layout first", () => {}, t)
        : this.toggle(`layout-${name}`, enabled, busy, enabled ? "Leave it out of the layout switcher" : "Put it back in the layout switcher", (cx) => this.toggleLayout(name, enabled, cx), t));
      return this.row(`layout-${name}`, title, enabled ? null : "off: moved to layouts-disabled", right, t);
    });
    return this.section("layouts", "Layouts", "Ctrl+Shift+L cycles through the ones that are on", rows, t);
  }

  partsSection(t) {
    const list = parts(layout());
    const rows = list.map((p) => this.row(`part-${p.id}`,
      [div().text_size(13).font_medium().text_color(p.hidden ? t.dim : t.foreground).child(p.id)],
      p.mods.join(", "),
      [this.toggle(`part-${p.id}`, !p.hidden, false, p.hidden ? "Show it" : "Hide it", () => run(p.hidden ? "layout.show" : "layout.hide", { id: p.id }), t)], t));
    return this.section("parts", `Parts of the ${shared("layout") ?? ""} layout`, "show or hide each one", rows, t);
  }

  builtinSection(t) {
    const used = usedIn(layout());
    const theirs = this.mods.filter((m) => this.builtin.has(m.name));
    const rows = theirs.map((m) => this.row(`builtin-${m.name}`,
      [div().text_size(13).font_medium().text_color(t.foreground).child(m.name), ...(m.title && m.title !== m.name ? [div().text_size(12).text_color(t.muted).child(m.title)] : []), ...(used.has(m.name) ? [this.badge("in this layout", t, t.accent)] : [])],
      null, [], t));
    return this.section("builtin", "Built-in mods", `${theirs.length} · Herdr puts these back on every start`, rows, t);
  }

  render(cx) {
    const visible = shown();
    if (visible && !this.wasShown && !checking()) this.refresh(cx);
    // A machine that was still connecting when the page opened.
    if (visible && !checking()) for (const m of machines()) if (!this.plugins[m.name ?? ""] && !this.pluginErrors[m.name ?? ""]) this.loadMachine(m, cx);
    this.wasShown = visible;
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.canvas)
      .child(h_flex().h(42).flex_none().px(20).gap(10).items_center().bg(t.chrome).border_b_1().border_color(t.border)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Plugins"))
        .child(div().text_size(12).text_color(t.dim).child("mods, terminal plugins and layouts"))
        .child(div().flex_1())
        .child(div().id("refresh").px(10).py(3).rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx)).child("Refresh")))
      .child(div().id("plugins-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().gap(28).p(20)
          .child(this.modCards(t))
          .child(this.pluginCards(t))
          .child(v_flex().gap(16).max_w(900)
            .child(this.layoutsSection(t))
            .child(this.partsSection(t))
            .child(this.builtinSection(t)))));
  }
}
