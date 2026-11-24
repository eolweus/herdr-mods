import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { checking, closeOverlay, exec, focused, home, machines, nextCommand, openOverlay, panes, props, run, shared, spaces, theme } from "herdr";

const ACTIONS = [
  ["t", "Terminal", "A shell in this folder"],
  ["c", "Claude", "A Claude chat in this folder"],
  ["f", "Folder", "Pick another folder first"],
];
const BROWSER = ["b", "Browser", "A web browser (terminal-browser)"];
const BROWSER_ARGV = ["/bin/zsh", "-lc", 'cd "$1" 2>/dev/null; exec herdr-browser here', "zsh"];

const TITLES = { split: "What goes here?", tab: "New tab", space: "New space" };

const tilde = (path, h) => (h && path?.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "");

export default class Launcher extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.overlay ? "space" : p.mode ?? "split";
    this.me = this.mode === "space" ? null : p.pane ?? this.focusedLauncher();
    this.direction = p.direction ?? "right";
    this.space = spaces().find((s) => s.id === focused()?.space);
    this.machine = this.space?.machine ?? null;
    this.home = this.machine ? null : home();
    this.source = this.mode === "tab" ? null : this.sourcePane();
    this.cwd = p.cwd ?? this.paneCwd(this.source) ?? this.spaceCwd() ?? this.space?.folder ?? null;
    this.pickId = null;
    this.keys = InputState.new({});
    this.keys.on("change", (_e, cx) => {
      const k = this.keys.value().slice(-1).toLowerCase();
      this.keys.set_value("");
      if (k) this.act(k, cx);
    });
    this.handle = cx.focus_handle();
    this.keys.focus();
    cx.timer.after(150, () => this.refocus());
    cx.timer.after(600, () => this.refocus());
    if (checking()) return;
    // Herdr sends "focus" only for pane.go, not when closing a neighbour hands the pane focus back.
    cx.timer.every(200, () => {
      const now = this.isFocused();
      if (now && !this.wasFocused) this.refocus();
      this.wasFocused = now;
    });
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "focus" && this.isFocused()) this.refocus();
        cx.notify();
      }
    });
    if (this.machine) this.loadHome(cx);
  }

  loadHome(cx) {
    const machine = this.machine;
    cx.spawn(async (cx) => {
      try {
        const h = (await exec("sh", ["-c", "printf %s \"$HOME\""], { on: machine })).stdout;
        if (this.machine === machine) { this.home = h; this.cwd = this.cwd?.startsWith("~") ? h + this.cwd.slice(1) : this.cwd ?? h; }
      } catch {}
      cx.notify();
    });
  }

  // A new space can go on any reachable machine; its folder starts at that machine's home.
  nextMachine(cx) {
    const names = machines().filter((m) => m.layout !== "unavailable").map((m) => m.name);
    if (names.length < 2) return;
    this.machine = names[(names.indexOf(this.machine) + 1) % names.length];
    this.home = this.machine ? null : home();
    this.cwd = this.home;
    if (this.machine) this.loadHome(cx);
  }

  refocus() {
    this.keys.focus();
  }

  isFocused() {
    if (this.mode === "space") return true;
    const me = this.pane();
    return Boolean(me) && focused()?.pane === me;
  }

  // panes() marks each tab's focused pane, so only the focused tab's launcher is this one.
  focusedLauncher() {
    const tab = focused()?.tab;
    return panes().find((x) => x.mod === "launcher" && x.focused && x.tab === tab)?.pane;
  }

  pane() {
    this.me ??= this.focusedLauncher();
    return this.me;
  }

  paneCwd(pane) {
    const x = pane && panes().find((y) => y.pane === pane);
    if (!x) return null;
    if (x.mod !== "herdr-chat") return x.cwd;
    const c = shared(`herdr-chat:pane:${pane}`) ?? {};
    if (c.cwd) return c.cwd;
    // Chats from before `cwd` was published only share the folder with ~ for home.
    return c.folder?.startsWith("~") && this.home ? this.home + c.folder.slice(1) : c.folder || null;
  }

  // Like Herdr's own mods: a space's folder is where its first terminal or chat is now.
  spaceCwd() {
    const tabs = new Set((this.space?.tabs ?? []).map((t) => t.id));
    for (const x of panes()) if (tabs.has(x.tab) && x.mod !== "launcher") {
      const cwd = this.paneCwd(x.pane);
      if (cwd) return cwd;
    }
    return null;
  }

  dismiss() {
    if (this.mode === "space") return closeOverlay(props().overlay);
    const me = this.pane();
    if (me) run("pane.close", { pane: me });
  }

  // A split lands right after the pane it came from, so that's the nearest pane before the launcher.
  sourcePane() {
    const all = panes();
    const f = all.find((x) => x.pane === focused()?.pane);
    if (f && f.mod !== "launcher") return f.pane;
    const me = this.pane() ?? f?.pane;
    const tab = all.find((x) => x.pane === me)?.tab ?? f?.tab;
    const mine = all.filter((x) => x.tab === tab);
    const at = mine.findIndex((x) => x.pane === me);
    const before = mine.slice(0, Math.max(at, 0)).reverse().find((x) => x.mod !== "launcher");
    return (before ?? mine.find((x) => x.mod !== "launcher"))?.pane ?? null;
  }

  // Close first, then split where the launcher came from, so sizes match a plain split.
  // The source can be gone by now (closed while the launcher waited); then pick again, or fill the launcher's place.
  replace(open, fill) {
    const me = this.pane();
    if (!me) return;
    if (!panes().some((x) => x.pane === this.source)) this.source = this.sourcePane();
    if (!this.source) return fill();
    run("pane.close", { pane: me });
    run("pane.focus", { pane: this.source });
    open(this.source);
  }

  // The launcher is a tab's only pane: split it, then close it, and the new pane fills the tab.
  fillTab(args) {
    const me = this.pane();
    if (!me) return;
    if (args) run("pane.split", { pane: me, direction: "right", ...args });
    else if (this.cwd) run("terminal.open", { folder: this.cwd, place: "right" });
    else run("pane.split", { pane: me, direction: "right" });
    run("pane.close", { pane: me });
  }

  newSpace(cx, chat) {
    const before = new Set(spaces().map((s) => s.id));
    run("space.new", { folder: this.cwd ?? undefined, machine: this.machine ?? "" });
    if (!chat) return closeOverlay(props().overlay);
    run("tab.new", { mod: "herdr-chat", props: this.chatProps() });
    // space.new always starts with a shell tab; once the space shows up, drop it so only the chat remains.
    cx.timer.after(400, () => {
      const made = spaces().find((s) => !before.has(s.id));
      const chatTabs = new Set(panes().filter((x) => x.mod === "herdr-chat").map((x) => x.tab));
      for (const t of made?.tabs ?? []) if (!chatTabs.has(t.id)) run("tab.close", { id: t.id, confirmed: true });
      closeOverlay(props().overlay);
    });
  }

  chatProps() {
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return { cwd: this.cwd, machine: this.machine, key };
  }

  terminal(cx) {
    if (this.mode === "space") return this.newSpace(cx, false);
    if (this.mode === "tab") return this.fillTab(null);
    this.replace((source) => this.cwd
      ? run("terminal.open", { folder: this.cwd, place: this.direction })
      : run("pane.split", { pane: source, direction: this.direction }), () => this.fillTab(null));
  }

  claude(cx) {
    if (this.mode === "space") return this.newSpace(cx, true);
    if (this.mode === "tab") return this.fillTab({ mod: "herdr-chat", props: this.chatProps() });
    const chat = { mod: "herdr-chat", props: this.chatProps() };
    this.replace((source) => run("pane.split", { pane: source, direction: this.direction, ...chat }), () => this.fillTab(chat));
  }

  browser() {
    const split = { argv: [...BROWSER_ARGV, this.cwd ?? ""] };
    if (this.mode === "tab") return this.fillTab(split);
    this.replace((source) => run("pane.split", { pane: source, direction: this.direction, ...split }), () => this.fillTab(split));
  }

  pickFolder() {
    this.pickId = `launcher-${Date.now().toString(36)}`;
    openOverlay({ mod: "folder-picker", kind: "dialog", width: 320, props: { id: this.pickId, machine: this.machine, folder: this.cwd } });
  }

  // The folder picker answers through shared state; only our own request counts.
  takePick() {
    const r = shared("folder-picker.result");
    if (!this.pickId || r?.id !== this.pickId) return;
    this.pickId = null;
    if (r.folder) this.cwd = r.folder;
    this.refocus();
  }

  act(k, cx) {
    if (k === "t") this.terminal(cx);
    else if (k === "c") this.claude(cx);
    else if (k === "f") this.pickFolder();
    else if (k === "b" && this.canBrowse()) this.browser();
    else if (k === "m" && this.mode === "space") this.nextMachine(cx);
    else if (k === "q") this.dismiss();
    cx.notify();
  }

  key(e, cx) {
    const k = e.key;
    if (k === "escape") {
      this.dismiss();
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // herdr-browser and the bridge only exist on this Mac.
  canBrowse() {
    return this.mode !== "space" && !this.machine;
  }

  render() {
    this.takePick();
    const t = theme();
    const badge = (k) => div().w(26).h(26).flex().items_center().justify_center().rounded(7)
      .border_1().border_color(t.input).bg(t.raised).text_size(12.5).font_semibold().text_color(t.accent).child(k.toUpperCase());
    const others = machines().filter((m) => m.layout !== "unavailable").length > 1;
    const actions = this.mode === "space" && others ? [...ACTIONS, ["m", "Machine", `On ${this.machine ?? "this computer"} · press to switch`]]
      : this.canBrowse() ? [...ACTIONS, BROWSER] : ACTIONS;
    const menu = v_flex().gap(4).w(340).children(actions.map(([k, label, hint]) => {
      return h_flex().id(`launch-${k}`).gap(14).px(12).py(9).items_center().rounded(10)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.act(k, cx))
        .child(badge(k))
        .child(v_flex().gap(1)
          .child(div().text_size(14).text_color(t.foreground).child(label))
          .child(div().text_size(12).text_color(t.dim).child(hint)));
    }));
    return v_flex().id("launcher").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_click((_e, cx) => { this.refocus(); cx.notify(); })
      .size_full().bg(t.background).text_color(t.foreground)
      .child(div().absolute().w(1).h(1).opacity(0).overflow_hidden().child(Input.new(this.keys).w(1).h(1)))
      .child(v_flex().flex_1().items_center().justify_center().gap(26)
        .child(div().text_size(13).text_color(t.dim).child(TITLES[this.mode]))
        .child(menu))
      .child(h_flex().h(34).px(16).gap(8).items_center().border_t_1().border_color(t.border).text_size(12)
        .child(div().text_color(t.dim).child(this.machine ?? "this computer"))
        .child(div().text_color(t.dim).child("·"))
        .child(div().flex_1().truncate().text_color(t.muted).child(tilde(this.cwd, this.home) || "no folder"))
        .child(div().text_color(t.dim).child("Esc to close")));
  }
}
