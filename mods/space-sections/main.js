// The space and section right-click menus, plus the section name prompt.
// props { tab: "space" | "section", target: { id } } for a menu,
// props { mode: "name", section?, space?, value? } for the prompt.
// Sections live in shared "space.sections": [{ id, name, spaces: [space ids] }].

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes, exec, shared, setShared } from "herdr";

const sections = () => shared("space.sections") ?? [];
const save = (list) => setShared("space.sections", list);
const without = (list, space) => list.map((s) => ({ ...s, spaces: s.spaces.filter((id) => id !== space) }));

function moveTo(space, section) {
  save(without(sections(), space).map((s) => (s.id === section ? { ...s, spaces: [...s.spaces, space] } : s)));
}

function rename(section, name) {
  save(sections().map((s) => (s.id === section ? { ...s, name } : s)));
}

function create(name, space) {
  const list = space ? without(sections(), space) : sections();
  save([...list, { id: `s${Date.now().toString(36)}`, name, spaces: space ? [space] : [] }]);
}

function shift(section, by) {
  const list = [...sections()];
  const i = list.findIndex((s) => s.id === section);
  list.splice(i + by, 0, list.splice(i, 1)[0]);
  save(list);
}

function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

const nameIt = (p) => openOverlay({ mod: "space-sections", kind: "dialog", width: 380, height: 200, props: { mode: "name", ...p } });

// An item is [label, icon, action]; a null is a divider.
function items(p, git) {
  const id = p?.target?.id;
  const list = sections();
  if (p?.tab === "panel") return [
    ["New section…", "folder-plus", () => nameIt({})],
    ["New space", "plus", () => run("space.new")],
  ];
  if (p?.tab === "section") {
    const s = list.find((x) => x.id === id);
    return [
      ["Rename section", "square-pen", () => nameIt({ section: id, value: s?.name ?? "" })],
      ["New section", "folder-plus", () => nameIt({})],
      ...(list[0]?.id !== id ? [["Move up", "chevron-left", () => shift(id, -1)]] : []),
      ...(list.at(-1)?.id !== id ? [["Move down", "chevron-right", () => shift(id, 1)]] : []),
      null,
      ["Delete section", "x", () => save(list.filter((x) => x.id !== id))],
    ];
  }
  const mine = list.find((s) => s.spaces.includes(id));
  return [
    ["Rename", "square-pen", () => run("space.rename", { id })],
    ...(git ? [
      ["New worktree", "git-branch", () => openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: id, action: "new" } })],
      ["Open worktree", "git-branch", () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: id, action: "open" } })],
    ] : []),
    ...(git === "linked" ? [["Remove worktree", "git-branch", () => openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: id, action: "remove" } })]] : []),
    null,
    ...list.filter((s) => s !== mine).map((s) => [`Move to ${s.name}`, "folder", () => moveTo(id, s.id)]),
    ["New section…", "folder-plus", () => nameIt({ space: id })],
    ...(mine ? [[`Remove from ${mine.name}`, "minus", () => save(without(list, id))]] : []),
    null,
    ["Close", "x", () => run("space.close", { id })],
  ];
}

export default class SpaceSections extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.handle = cx.focus_handle();
    if (p.mode === "name") {
      this.text = p.value ?? "";
      this.input = InputState.new({ value: this.text });
      if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
      this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
      this.input.on("submit", () => this.submit());
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
      return;
    }
    this.at = 0;
    this.git = null;
    this.handle.focus();
    const space = p.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder) cx.spawn(async (cx) => {
      this.git = await checkout(folder, space.machine).catch(() => null);
      cx.notify();
    });
  }

  submit() {
    const p = props();
    const name = this.text.trim();
    closeOverlay(p.overlay);
    if (!name) return;
    if (p.section) rename(p.section, name);
    else create(name, p.space);
  }

  choose(it) {
    if (!it) return;
    closeOverlay(props()?.overlay);
    it[2]();
  }

  renderName(t) {
    const p = props() ?? {};
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("section-name").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(p.section ? "Rename section" : "New section"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("sn-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("sn-save", "Save", true, () => this.submit())));
  }

  render() {
    const t = theme();
    if (props()?.mode === "name") return this.renderName(t);
    const list = items(props(), this.git);
    const live = list.filter(Boolean);
    return v_flex().id("menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % live.length;
        else if (e.key === "up") this.at = (this.at + live.length - 1) % live.length;
        else if (e.key === "enter") this.choose(live[this.at]);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => it === null
        ? div().mx(7).my(4).h(1).flex_none().bg(t.border)
        : h_flex().id(`mi-${i}`).h(31).flex_none().px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(live.indexOf(it) === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.choose(it))
          .child(svg(`mods/workspace-chrome/${it[1]}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(it[0]))));
  }
}
