// Pick a folder on any machine. Open it as an overlay:
//   openOverlay({ mod: "folder-picker", kind: "popup", width: 280, props: { id, machine, folder } })
// view "recent" (default) lists recent folders with search and "Open folder…"; view "browse" is the
// folder browser (kind "dialog", 540x500). The choice lands in shared "folder-picker.result" as
// { id, folder, machine, at }; callers match their own id.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { checking, closeOverlay, exec, home, openOverlay, props, setShared, shared, theme } from "herdr";

const RECENT_KEY = "folder-picker.recent";
const SHOWN = 8;
const KEPT = 30;

const icon = (name) => `mods/folder-picker/${name}.svg`;
const tilde = (path, h) => (h && path && (path === h || path.startsWith(`${h}/`)) ? `~${path.slice(h.length)}` : path ?? "");
const base = (path) => (path === "/" ? "/" : path.replace(/\/+$/, "").split("/").pop());
const parent = (path) => path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
const machineKey = (m) => m ?? "local";

// zoxide's rule for `z a b`: the words appear in order, and the last one in the folder's own name.
const zMatch = (path, words) => {
  const p = path.toLowerCase();
  let at = 0;
  for (const w of words) {
    const i = p.indexOf(w, at);
    if (i < 0) return false;
    at = i + w.length;
  }
  return base(p).includes(words[words.length - 1]);
};

const LIST = String.raw`
cd -- "$1" 2>/dev/null || { echo "No such folder: $1" >&2; exit 3; }
pwd
for d in * .*; do
  case "$d" in .|..) continue ;; esac
  [ -d "$d" ] && printf '%s\n' "$d"
done
true`;

export function browseSpec(p) {
  return { mod: "folder-picker", kind: "dialog", width: 540, height: 500, props: { ...p, view: "browse" } };
}

export default class FolderPicker extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.p = p;
    this.machine = p.machine ?? null;
    this.home = this.machine ? null : home();
    this.view = p.view === "browse" ? "browse" : "recent";
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.at = 0;
    this.error = null;
    if (this.view === "recent") this.initRecent(cx);
    else this.initBrowse(cx);
    if (checking()) return;
    if (this.machine) cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.machine }).catch(() => null);
      this.home = r?.stdout || this.home;
      if (this.view === "browse" && !this.path) this.load(this.start(), cx);
      cx.notify();
    });
  }

  expand(text) {
    const s = text.trim();
    if (s === "~" || s.startsWith("~/")) return this.home ? this.home + s.slice(1) : null;
    return s.startsWith("/") ? s : null;
  }

  choose(folder) {
    if (!folder) return;
    const all = shared(RECENT_KEY) ?? {};
    const k = machineKey(this.machine);
    all[k] = [folder, ...(all[k] ?? []).filter((f) => f !== folder)].slice(0, KEPT);
    setShared(RECENT_KEY, all);
    setShared("folder-picker.result", { id: this.p.id ?? null, folder, machine: this.machine, at: Date.now() });
    exec("zoxide", ["add", "--", folder], { on: this.machine }).catch(() => {});
    closeOverlay(this.p.overlay);
  }

  dismiss() {
    closeOverlay(this.p.overlay);
  }

  // Recent: folders picked here first, then zoxide's ranking. Picks go back into zoxide, so `z` learns them too.
  initRecent(cx) {
    this.query = "";
    this.dirs = [];
    this.search = InputState.new({ placeholder: "Search folders…" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.at = 0; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.pickRow(this.rows()[this.at], cx));
    this.search.focus();
    cx.timer.after(200, () => this.search.focus());
    if (checking()) return;
    cx.spawn(async (cx) => {
      const r = await exec("zoxide", ["query", "-l"], { on: this.machine }).catch(() => null);
      this.dirs = (r?.stdout ?? "").split("\n").filter(Boolean);
      cx.notify();
    });
  }

  candidates(searching) {
    const picked = (shared(RECENT_KEY) ?? {})[machineKey(this.machine)] ?? [];
    const seen = new Set();
    const hidden = (d) => !searching && base(d).startsWith(".");
    return [...picked, ...this.dirs.filter((d) => !hidden(d))].filter((d) => {
      if (seen.has(d) || d === "/" || d === this.home) return false;
      seen.add(d);
      return true;
    });
  }

  rows() {
    const q = this.query.trim();
    const path = this.expand(q);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = this.candidates(words.length > 0);
    let hits = all;
    if (words.length && !path) {
      hits = all.filter((d) => words.every((w) => d.toLowerCase().includes(w)));
      const rank = (d) => (zMatch(d, words) ? 0 : words.every((w) => base(d).toLowerCase().includes(w)) ? 1 : 2);
      hits = [0, 1, 2].flatMap((r) => hits.filter((d) => rank(d) === r));
    }
    const out = hits.slice(0, SHOWN).map((d) => ({ kind: "dir", path: d }));
    if (path) out.unshift({ kind: "go", path });
    out.push({ kind: "open" });
    return out;
  }

  pickRow(row, cx) {
    if (!row) return;
    if (row.kind === "dir") return this.choose(row.path);
    this.openBrowser(row.kind === "go" ? row.path : null);
  }

  openBrowser(folder) {
    openOverlay(browseSpec({ ...this.p, overlay: undefined, folder: folder ?? this.p.folder ?? null }));
    closeOverlay(this.p.overlay);
  }

  recentKey(e, cx) {
    const n = this.rows().length;
    if (e.key === "escape") return this.dismiss();
    if (e.key === "down") this.at = (this.at + 1) % n;
    else if (e.key === "up") this.at = (this.at + n - 1) % n;
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  renderRecent() {
    const t = theme();
    const rows = this.rows();
    const dirs = rows.filter((r) => r.kind !== "open");
    const row = (r, i) => {
      const on = i === this.at;
      const el = h_flex().id(`row-${i}`).mx(6).px(8).h(30).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(on ? t.hover : t.popover).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.pickRow(r, cx));
      if (r.kind === "open") return el.child(div().text_size(13).text_color(t.foreground).child("Open folder…"));
      if (r.kind === "go") return el
        .child(svg(icon("folder")).size(13).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(`Go to ${tilde(r.path, this.home)}`));
      return el
        .child(div().flex_none().max_w(150).truncate().text_size(13).text_color(t.foreground).child(base(r.path)))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(on ? t.dim : t.popover)
          .child(tilde(parent(r.path), this.home)));
    };
    return v_flex().id("folder-recent").track_focus(this.handle).on_key_down((e, cx) => this.recentKey(e, cx))
      .w_full().pb(6).bg(t.popover).text_color(t.foreground)
      .child(h_flex().h(40).px(12).items_center().border_b_1().border_color(t.border)
        .child(Input.new(this.search).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(div().px(14).pt(8).pb(4).text_size(11.5).text_color(t.dim)
        .child(this.query.trim() ? (dirs.length ? "Folders" : "No match") : this.machine ? `Recent on ${this.machine}` : "Recent"))
      .children(dirs.map((r, i) => row(r, i)))
      .child(div().mx(6).my(4).h(1).bg(t.border))
      .child(row(rows[rows.length - 1], rows.length - 1));
  }

  // Browse: one folder's subfolders, a path box, breadcrumbs and a filter.
  start() {
    return this.p.folder?.startsWith("~") ? this.expand(this.p.folder) : this.p.folder || this.home;
  }

  initBrowse(cx) {
    this.path = null;
    this.entries = [];
    this.loading = false;
    this.filter = "";
    this.creating = false;
    this.pathBox = InputState.new({ placeholder: "/path/to/folder" });
    this.pathBox.on("submit", (_e, cx) => this.go(cx));
    this.filterBox = InputState.new({ placeholder: "Filter folders" });
    this.filterBox.on("change", (_e, cx) => { this.filter = this.filterBox.value(); this.at = 0; cx.notify(); });
    this.filterBox.on("submit", (e, cx) => {
      if (e?.secondary) return this.choose(this.path);
      const hit = this.visible()[this.at];
      if (hit) this.load(hit.path, cx);
    });
    this.nameBox = InputState.new({ placeholder: "New folder name" });
    this.nameBox.on("submit", (_e, cx) => this.create(cx));
    this.typing = "filter";
    this.pathBox.on("focus", () => { this.typing = "path"; });
    this.filterBox.on("focus", () => { this.typing = "filter"; });
    this.nameBox.on("focus", () => { this.typing = "name"; });
    this.filterBox.focus();
    cx.timer.after(200, () => (this.creating ? this.nameBox : this.filterBox).focus());
    if (checking()) return;
    const s = this.start();
    if (s) this.load(s, cx);
  }

  go(cx) {
    const target = this.expand(this.pathBox.value()) ?? (this.path ? `${this.path.replace(/\/$/, "")}/${this.pathBox.value().trim()}` : null);
    if (target) this.load(target, cx);
    this.filterBox.focus();
  }

  load(path, cx) {
    this.loading = true;
    const nonce = (this.nonce ?? 0) + 1;
    this.nonce = nonce;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", LIST, "sh", path], { on: this.machine }).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      if (nonce !== this.nonce) return;
      this.loading = false;
      if (r.code !== 0) {
        this.error = r.stderr.trim() || `Can't open ${path}`;
      } else {
        const [where, ...names] = r.stdout.split("\n").filter(Boolean);
        this.path = where;
        this.entries = names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
        this.error = null;
        this.filter = "";
        this.filterBox.set_value("");
        this.at = 0;
        this.scroll.scroll_to_item(0);
      }
      this.pathBox.set_value(this.path ?? path);
      cx.notify();
    });
  }

  visible() {
    const f = this.filter.trim().toLowerCase();
    const names = this.entries.filter((n) => (f.startsWith(".") || !n.startsWith(".")) && (!f || n.toLowerCase().includes(f)));
    const up = this.path && this.path !== "/" && !f ? [{ name: "..", path: parent(this.path) }] : [];
    return [...up, ...names.map((n) => ({ name: n, path: `${this.path === "/" ? "" : this.path}/${n}` }))];
  }

  startCreate(cx) {
    this.creating = true;
    this.nameBox.set_value("");
    this.nameBox.focus();
    cx.notify();
  }

  create(cx) {
    const name = this.nameBox.value().trim();
    if (!name || !this.path) return;
    if (name.includes("/") || name === "." || name === "..") { this.error = "A folder name can't contain /"; return cx.notify(); }
    const target = `${this.path === "/" ? "" : this.path}/${name}`;
    cx.spawn(async (cx) => {
      const r = await exec("mkdir", ["--", target], { on: this.machine }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) { this.error = r.stderr.trim() || "Couldn't make the folder"; return cx.notify(); }
      this.creating = false;
      this.filterBox.focus();
      this.load(target, cx);
    });
  }

  browseKey(e, cx) {
    if (this.creating) {
      if (e.key !== "escape") return;
      this.creating = false;
      this.filterBox.focus();
    } else if (e.key === "escape") return this.dismiss();
    else {
      const n = this.visible().length;
      if (e.key === "down" && n) this.at = (this.at + 1) % n;
      else if (e.key === "up" && n) this.at = (this.at + n - 1) % n;
      else if (e.key === "backspace" && this.typing === "filter" && !this.filter && this.path && this.path !== "/") {
        this.load(parent(this.path), cx);
      } else return;
      if (n) this.scroll.scroll_to_item(this.at);
    }
    cx.stop_propagation();
    cx.notify();
  }

  crumbs(t) {
    const parts = (this.path ?? "").split("/").filter(Boolean);
    const crumb = (label, path, i) => div().id(`crumb-${i}`).px(4).py(1).rounded(4).cursor_pointer()
      .text_size(12.5).text_color(i === parts.length - 1 ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.load(path, cx)).child(label);
    const items = [];
    parts.forEach((p, i) => {
      items.push(svg(icon("chevron-right")).size(11).text_color(t.dim));
      items.push(crumb(p, `/${parts.slice(0, i + 1).join("/")}`, i));
    });
    return h_flex().gap(4).items_center().min_w(0).overflow_hidden()
      .child(div().id("crumb-home").p(3).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.home && this.load(this.home, cx))
        .child(svg(icon("home")).size(13).text_color(t.muted)))
      .children(items);
  }

  renderBrowse() {
    const t = theme();
    const list = this.visible();
    const button = (id, text, primary, action) => h_flex().id(id).h(30).px(12).items_center().rounded(7)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.85)).on_click(action).child(text);
    const row = (e, i) => h_flex().id(`dir-${i}`).px(10).h(30).flex_none().gap(10).items_center().rounded(6).cursor_pointer()
      .bg(i === this.at ? t.hover : t.background).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.load(e.path, cx))
      .child(svg(icon("folder")).size(14).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(e.name));
    const note = (text, color) => div().px(10).py(8).text_size(12.5).text_color(color ?? t.dim).child(text);
    return v_flex().id("folder-browse").track_focus(this.handle).on_key_down((e, cx) => this.browseKey(e, cx))
      .size_full().p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(12)
        .child(div().flex_1().text_size(15).font_semibold().child(this.machine ? `Select folder on ${this.machine}` : "Select folder"))
        .child(div().id("new-folder").px(6).py(2).rounded(5).cursor_pointer().text_size(13).text_color(t.foreground)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.startCreate(cx)).child("New folder"))
        .child(div().id("close").p(3).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => this.dismiss()).child(svg(icon("x")).size(15).text_color(t.muted))))
      .child(h_flex().gap(8).items_center()
        .child(Input.new(this.pathBox).flex_1().h(34).px(10).rounded(8).border_1().border_color(t.input)
          .bg(t.background).text_size(13).text_color(t.foreground))
        .child(button("go", "Go", false, (_e, cx) => this.go(cx))))
      .child(this.crumbs(t))
      .child(v_flex().flex_1().min_h(0).rounded(9).border_1().border_color(t.border).bg(t.background).overflow_hidden()
        .child(h_flex().m(6).h(32).px(10).gap(8).items_center().rounded(7).bg(t.raised)
          .child(svg(icon("search")).size(13).text_color(t.dim))
          .child(Input.new(this.filterBox).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .when(this.creating, (el) => el.child(h_flex().mx(6).mb(4).h(32).px(10).gap(10).items_center().rounded(7)
          .border_1().border_color(t.accent)
          .child(svg(icon("folder")).size(14).text_color(t.accent))
          .child(Input.new(this.nameBox).flex_1().h_full().text_size(13).text_color(t.foreground))))
        .child(v_flex().id("dirs").flex_1().min_h(0).px(6).pb(6).overflow_y_scrollbar().track_scroll(this.scroll)
          .children(this.error ? [note(this.error, t.blocked)]
            : !this.path || (this.loading && !list.length) ? [note("Reading…")]
            : !list.length ? [note(this.filter ? "No folder matches" : "No folders here")]
            : list.map(row))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.dim).child("↑↓ Enter to open · ⌫ up · ⌘Enter to select"))
        .child(button("cancel", "Cancel", false, () => this.dismiss()))
        .child(button("select", "Select folder", true, () => this.choose(this.path))));
  }

  render() {
    return this.view === "browse" ? this.renderBrowse() : this.renderRecent();
  }
}
