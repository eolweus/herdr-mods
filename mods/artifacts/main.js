import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { checking, closeOverlay, exec, layout, machines, notify, openOverlay, props, run, shared, theme } from "herdr";
import {
  HTML, LISTEN, freePort, hash, investigate, launch, loadRegistry, openInChrome, parseHtml, parseListeners,
  probe, running, sh, slug, stop, updateRegistry, urlFor,
} from "./data.js";

const EVERY_MS = 10000;
const SCAN_MS = 60000;
const ICON = (name) => `mods/artifacts/${name}.svg`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

const shown = () => find(layout(), "work-stack")?.active === "artifacts-view";
const online = () => machines().filter((m) => m.layout !== "unavailable");
const machineLabel = (machine) => machine ?? "This computer";
const machineColor = (machine) => (shared("machine.colors") ?? {})[machine ?? "local"] ?? null;
const tilde = (p) => (p ?? "").replace(/^\/(Users|home)\/[^/]+/, "~");

function since(at) {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function machineChip(machine, t) {
  const c = machineColor(machine);
  return div().flex_none().px(5).rounded(4).border_1().text_size(10)
    .bg(c ? `${c}1f` : t.raised).border_color(c ? `${c}66` : t.border).text_color(c ?? t.muted)
    .child(machineLabel(machine));
}

export default class Artifacts extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.edit) return this.initEditor(p, cx);
    this.registry = { apps: [], links: [] };
    this.live = [];
    this.ready = new Set();
    this.listeners = {};
    this.html = {};
    this.pending = new Set();
    this.investigating = new Set();
    this.armed = null;
    this.closed = new Set(["discover"]);
    this.seen = shared("artifacts.changed") ?? 0;
    this.scannedAt = 0;
    if (checking()) return;
    this.refresh(cx, true);
    cx.timer.every(EVERY_MS, (cx) => this.refresh(cx));
  }

  refresh(cx, force = false) {
    if (!force && !shown()) return;
    cx.spawn(async (cx) => {
      try {
        const [{ data }, live] = await Promise.all([loadRegistry(), running()]);
        this.registry = data;
        this.live = live;
        this.error = null;
        cx.notify();
        const ready = new Set();
        await Promise.all(live.map(async (r) => { if (await probe(r.machine, r.port)) ready.add(r.address); }));
        this.ready = ready;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
    if (force || Date.now() - this.scannedAt > SCAN_MS) this.scan(cx);
  }

  // Listening ports and Claude-written HTML on every machine: slower, so less often.
  scan(cx) {
    this.scannedAt = Date.now();
    for (const m of online()) {
      const k = m.name ?? "local";
      cx.spawn(async (cx) => {
        const [l, h] = await Promise.all([sh(LISTEN, [], m.name, 60000).catch(() => null), sh(HTML, [], m.name, 60000).catch(() => null)]);
        if (l) this.listeners[k] = parseListeners(l.stdout, m.name);
        if (h) this.html[k] = parseHtml(h.stdout, m.name);
        cx.notify();
      });
    }
  }

  liveApp(app) {
    return this.live.find((r) => r.kind === "app" && r.id === app.id && r.machine === (app.machine ?? null));
  }

  liveHtml(item) {
    return this.live.find((r) => r.kind === "html" && r.id === hash(item.dir) && r.machine === item.machine);
  }

  busy(key, cx, work) {
    this.pending.add(key);
    this.armed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await work(); } catch (e) { notify({ title: "Artifacts", body: String(e?.message ?? e), level: "error" }); }
      this.pending.delete(key);
      this.refresh(cx, true);
    });
  }

  start(app, cx) {
    this.busy(app.id, cx, async () => {
      const port = app.port ?? (await freePort(app.machine));
      await launch(`app-${app.id}-${port}`, app.machine, app.folder, app.command, port);
      notify({ title: `Starting ${app.name}`, body: urlFor(app.machine, port, app.path), level: "info", timeout: 3000 });
    });
  }

  stopApp(r, key, cx) {
    this.busy(key, cx, () => stop(r.address));
  }

  // Local files open straight in Chrome; another machine's folder gets a static server first.
  openHtml(item, cx) {
    if (!item.machine) return void openInChrome(item.main);
    const r = this.liveHtml(item);
    const file = item.main.slice(item.dir.length);
    if (r) return void openInChrome(urlFor(item.machine, r.port, file));
    this.busy(item.id, cx, async () => {
      const port = await freePort(item.machine);
      await launch(`html-${hash(item.dir)}-${port}`, item.machine, item.dir, 'exec python3 -m http.server "$PORT" --bind 0.0.0.0', port);
      for (let i = 0; i < 20 && !(await probe(item.machine, port)); i++) await exec("sleep", ["0.25"]);
      await openInChrome(urlFor(item.machine, port, file));
    });
  }

  save(p, cx) {
    this.investigating.add(p.id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const draft = await investigate(p);
        openOverlay({ mod: "artifacts", kind: "dialog", width: 560, props: { edit: "app", item: draft } });
      } catch (e) {
        notify({ title: "Couldn't work out how to start it", body: String(e?.message ?? e), level: "error" });
      }
      this.investigating.delete(p.id);
      cx.notify();
    });
  }

  remove(kind, id, cx) {
    this.busy(id, cx, () => updateRegistry((d) => { d[kind] = d[kind].filter((x) => x.id !== id); }));
  }

  edit(kind, item) {
    openOverlay({ mod: "artifacts", kind: "dialog", width: 560, props: { edit: kind, item } });
  }

  toggleCard(key, cx) {
    if (this.closed.has(key)) this.closed.delete(key); else this.closed.add(key);
    cx.notify();
  }

  // UI pieces

  button(id, icon, label, action, t, tone) {
    const color = tone === "danger" ? t.blocked : tone === "accent" ? t.accent : null;
    return h_flex().id(id).h(24).px(7).gap(5).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(color ?? t.border).bg(t.raised)
      .text_size(11).text_color(color ?? t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(11)))
      .when(Boolean(label), (el) => el.child(label));
  }

  primary(id, icon, label, action, t) {
    return h_flex().id(id).h(28).px(11).gap(6).items_center().rounded(7).cursor_pointer()
      .bg(t.solid).text_color(t.solid_foreground).text_size(12).font_medium()
      .hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => action(cx))
      .child(svg(ICON(icon)).size(12)).child(label);
  }

  dot(state, t) {
    if (state === "busy" || state === "starting") return svg(ICON("spinner")).size(10).text_color(t.working).spin(900);
    return div().size(7).rounded(4).bg(state === "running" ? t.done : t.dim);
  }

  card(key, icon, title, sub, actions, body, t) {
    const open = !this.closed.has(key);
    return v_flex().rounded(12).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().id(`card-${key}`).gap(10).px(14).py(12).items_center().cursor_pointer()
        .on_click((_e, cx) => this.toggleCard(key, cx))
        .child(svg(ICON(open ? "chevron" : "chevron-right")).size(12).text_color(t.dim))
        .child(svg(ICON(icon)).size(15).text_color(t.muted))
        .child(div().text_size(14.5).font_semibold().text_color(t.foreground).child(title))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(sub))
        .children(actions))
      .when(open, (el) => el.child(v_flex().px(8).pb(10).gap(1).children(body)));
  }

  row(id, state, title, chipMachine, sub, right, actions, t) {
    return h_flex().id(id).gap(12).px(10).py(7).items_center().rounded(7).hover((s) => s.bg(t.hover))
      .child(div().w(10).flex_none().flex().justify_center().child(this.dot(state, t)))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center().min_w(0)
          .when(chipMachine !== undefined, (el) => el.child(machineChip(chipMachine, t)))
          .child(div().text_size(12.5).font_medium().truncate().text_color(t.foreground).child(title)))
        .child(div().text_size(11).truncate().text_color(t.dim).child(sub)))
      .child(div().w(200).flex_none().text_size(11.5).truncate().text_color(t.muted).child(right ?? ""))
      .child(h_flex().flex_none().gap(5).justify_end().children(actions));
  }

  empty(text, t) {
    return div().px(10).py(8).text_size(12).text_color(t.dim).child(text);
  }

  appRow(app, t) {
    const r = this.liveApp(app);
    const busy = this.pending.has(app.id);
    const state = busy ? "busy" : r ? (this.ready.has(r.address) ? "running" : "starting") : "stopped";
    const url = r ? urlFor(app.machine, r.port, app.path) : null;
    const portText = r ? url.replace(/^http:\/\//, "") : app.port ? `port ${app.port}` : "any free port";
    const deleting = this.armed === `del:${app.id}`;
    const actions = [
      r ? this.button(`stop-${app.id}`, "pause", "Stop", (cx) => this.stopApp(r, app.id, cx), t)
        : this.button(`start-${app.id}`, "play", "Start", (cx) => this.start(app, cx), t, "accent"),
      r && this.button(`open-${app.id}`, "external", "Open", () => openInChrome(url), t),
      r && this.button(`logs-${app.id}`, "logs", null, () => run("terminal.peek", { terminal: r.address }), t),
      this.button(`edit-${app.id}`, "pencil", null, () => this.edit("app", app), t),
      deleting
        ? this.button(`del-${app.id}`, "x", "Remove?", (cx) => this.remove("apps", app.id, cx), t, "danger")
        : this.button(`del-${app.id}`, "x", null, (cx) => { this.armed = `del:${app.id}`; cx.notify(); }, t),
    ].filter(Boolean);
    return this.row(`app-${app.id}`, state, app.name, app.machine ?? null, `${tilde(app.folder)} · ${app.command}`, portText, actions, t);
  }

  discoverRow(p, t) {
    const saved = this.registry.apps.some((a) => (a.machine ?? null) === p.machine && a.folder === p.cwd);
    const ours = this.live.some((r) => r.machine === p.machine && p.ports.includes(r.port));
    const looking = this.investigating.has(p.id);
    const actions = [
      p.http.length > 0 && this.button(`dopen-${p.id}`, "external", "Open", () => openInChrome(urlFor(p.machine, p.http[0])), t),
      ours ? null : saved
        ? div().text_size(11).text_color(t.dim).child("saved")
        : this.button(`dsave-${p.id}`, looking ? "spinner" : "sparkle", looking ? "Working it out…" : "Save as app", (cx) => { if (!looking) this.save(p, cx); }, t, "accent"),
    ].filter(Boolean);
    const ports = p.ports.map((x) => (p.http.includes(x) ? `${x}` : `${x} (not http)`)).join(", ");
    return this.row(`disc-${p.id}`, ours ? "running" : "stopped", tilde(p.cwd), p.machine, p.args, `port ${ports}`, actions, t);
  }

  htmlRow(item, t) {
    const r = item.machine ? this.liveHtml(item) : null;
    const busy = this.pending.has(item.id);
    const name = item.main.split("/").pop();
    const more = item.files.length > 1 ? ` · +${item.files.length - 1} more` : "";
    const actions = [
      this.button(`hopen-${item.id}`, busy ? "spinner" : "external", "Open", (cx) => this.openHtml(item, cx), t),
      r && this.button(`hstop-${item.id}`, "pause", "Stop server", (cx) => this.stopApp(r, item.id, cx), t),
    ].filter(Boolean);
    return this.row(`html-${item.id}`, busy ? "busy" : r ? "running" : "stopped", name, item.machine, `${tilde(item.dir)}${more}`, since(item.mtime), actions, t);
  }

  linkRow(link, t) {
    const deleting = this.armed === `del:${link.id}`;
    const actions = [
      this.button(`lopen-${link.id}`, "external", "Open", () => openInChrome(link.url), t),
      this.button(`ledit-${link.id}`, "pencil", null, () => this.edit("link", link), t),
      deleting
        ? this.button(`ldel-${link.id}`, "x", "Remove?", (cx) => this.remove("links", link.id, cx), t, "danger")
        : this.button(`ldel-${link.id}`, "x", null, (cx) => { this.armed = `del:${link.id}`; cx.notify(); }, t),
    ];
    return this.row(`link-${link.id}`, "stopped", link.name, undefined, link.url, "", actions, t);
  }

  render(cx) {
    if (this.editor) return this.renderEditor();
    const visible = shown();
    const changed = shared("artifacts.changed") ?? 0;
    if ((visible && !this.wasShown) || changed !== this.seen) {
      this.seen = changed;
      if (!checking()) this.refresh(cx, true);
    }
    this.wasShown = visible;
    const t = theme();
    const apps = this.registry.apps;
    const listeners = Object.values(this.listeners).flat();
    const html = Object.values(this.html).flat().sort((a, b) => b.mtime - a.mtime);
    const up = apps.filter((a) => this.liveApp(a)).length;
    return v_flex().size_full().min_h(0).bg(t.canvas)
      .child(h_flex().h(42).flex_none().px(20).gap(10).items_center().bg(t.chrome).border_b_1().border_color(t.border)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Artifacts"))
        .child(div().text_size(12).text_color(t.dim).child("Apps on every machine, and what Claude made"))
        .child(div().flex_1())
        .child(this.primary("add-app", "plus", "Add app", () => this.edit("app", null), t))
        .child(this.button("pin-link", "link", "Pin link", () => this.edit("link", null), t))
        .child(this.button("refresh", "reset", "Refresh", (cx) => this.refresh(cx, true), t)))
      .when(Boolean(this.error), (el) => el.child(div().px(20).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().id("artifacts-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().gap(16).p(16)
          .child(this.card("apps", "server", "Apps", apps.length ? `${up} of ${apps.length} running` : "", [],
            apps.length ? apps.map((a) => this.appRow(a, t)) : [this.empty("No apps yet. Add one, or save a running one from Discover.", t)], t))
          .child(this.card("discover", "search", "Discover", `${listeners.length} servers listening on your machines`, [],
            listeners.length ? listeners.map((p) => this.discoverRow(p, t)) : [this.empty("Nothing listening right now.", t)], t))
          .child(this.card("claude", "sparkle", "Claude artifacts", "Pinned claude.ai links and HTML that sessions wrote in the last 30 days",
            [this.button("open-claude-artifacts", "external", "claude.ai/artifacts", () => openInChrome("https://claude.ai/artifacts"), t)],
            [
              ...this.registry.links.map((l) => this.linkRow(l, t)),
              ...(html.length ? html.map((h) => this.htmlRow(h, t)) : [this.empty("No HTML files from Claude sessions found.", t)]),
            ], t))));
  }

  // The add/edit dialog, a second copy of this mod opened as an overlay.

  initEditor(p, cx) {
    const item = p.item ?? {};
    this.editor = p.edit;
    this.item = item;
    this.machine = item.machine ?? null;
    this.saving = false;
    this.problem = null;
    this.pickId = null;
    const field = (key, value, placeholder) => {
      const s = InputState.new({ value: value == null ? "" : String(value), placeholder });
      s.on("submit", (_e, cx) => this.saveEditor(cx));
      s.on("change", (_e, cx) => { this.problem = null; cx.notify(); });
      return [key, s];
    };
    this.fields = Object.fromEntries(p.edit === "link"
      ? [field("name", item.name, "My artifact"), field("url", item.url, "https://claude.ai/artifact/…")]
      : [field("name", item.name, "My app"), field("folder", item.folder, "/path/to/project"),
        field("command", item.command, "npm run dev -- --port $PORT"), field("port", item.port, "any free port"), field("path", item.path ?? "/", "/")]);
    this.fields.name.focus();
    cx.timer.after(300, () => this.fields.name.focus());
    this.handle = cx.focus_handle();
  }

  value(key) {
    return this.fields[key]?.value().trim() ?? "";
  }

  pickFolder() {
    this.pickId = `artifacts-${Date.now().toString(36)}`;
    openOverlay({ mod: "folder-picker", kind: "dialog", width: 320, props: { id: this.pickId, machine: this.machine, folder: this.value("folder") || null } });
  }

  takePick() {
    const r = shared("folder-picker.result");
    if (!this.pickId || r?.id !== this.pickId) return;
    this.pickId = null;
    if (r.folder) this.fields.folder.set_value(r.folder);
  }

  saveEditor(cx) {
    if (this.saving) return;
    const link = this.editor === "link";
    const name = this.value("name");
    const port = this.value("port");
    if (!name) return void (this.problem = "Give it a name.", cx.notify());
    if (link && !/^https?:\/\//.test(this.value("url"))) return void (this.problem = "The link needs to start with http:// or https://.", cx.notify());
    if (!link && (!this.value("folder") || !this.value("command"))) return void (this.problem = "Folder and command are needed.", cx.notify());
    if (!link && port && !/^\d{2,5}$/.test(port)) return void (this.problem = "The port is a number, or empty for any free port.", cx.notify());
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await updateRegistry((d) => {
          const list = link ? d.links : d.apps;
          const id = this.item.id ?? slug(name, new Set(list.map((x) => x.id)));
          const entry = link
            ? { id, name, url: this.value("url") }
            : { id, name, machine: this.machine, folder: this.value("folder"), command: this.value("command"),
              port: port ? Number(port) : null, path: this.value("path") || "/", ...(this.item.notes ? { notes: this.item.notes } : {}) };
          const at = list.findIndex((x) => x.id === id);
          if (at >= 0) list[at] = entry; else list.push(entry);
        });
        closeOverlay(props().overlay);
      } catch (e) {
        this.problem = String(e?.message ?? e);
        this.saving = false;
      }
      cx.notify();
    });
  }

  renderEditor() {
    this.takePick();
    const t = theme();
    const link = this.editor === "link";
    const input = (key) => Input.new(this.fields[key]).h(34).px(10).rounded(8).border_1().border_color(t.input)
      .bg(t.background).text_size(12.5).text_color(t.foreground);
    const labelled = (label, el, hint) => v_flex().gap(4)
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
      .child(el)
      .when(Boolean(hint), (x) => x.child(div().text_size(11).text_color(t.dim).child(hint)));
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const machinePicker = h_flex().gap(4).children(online().map((m) => {
      const on = (m.name ?? null) === this.machine;
      return div().id(`m-${m.name ?? "local"}`).px(9).py(4).rounded(6).border_1().cursor_pointer().text_size(12)
        .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.machine = m.name ?? null; cx.notify(); })
        .child(machineLabel(m.name));
    }));
    const title = link ? (this.item.id ? "Edit link" : "Pin a link") : this.item.id ? `Edit ${this.item.name}` : this.item.name ? `Save ${this.item.name}` : "Add an app";
    return v_flex().id("artifacts-edit").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(this.item.notes), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(`Claude: ${this.item.notes}`)))
      .child(labelled("Name", input("name")))
      .when(link, (el) => el.child(labelled("Link", input("url"))))
      .when(!link, (el) => el
        .child(labelled("Machine", machinePicker))
        .child(labelled("Folder", h_flex().gap(6).child(input("folder").flex_1())
          .child(button("pick", "Pick…", false, () => this.pickFolder()))))
        .child(labelled("Start command", input("command"), "Runs in the machine's login shell from the folder. $PORT holds the port."))
        .child(h_flex().gap(10).items_start()
          .child(labelled("Port", input("port"), "Empty: a free port each time").w(200))
          .child(labelled("Open at", input("path")).flex_1())))
      .when(Boolean(this.problem), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.problem)))
      .child(h_flex().pt(4).gap(8).justify_end()
        .child(button("ed-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("ed-save", this.saving ? "Saving…" : "Save", true, (_e, cx) => this.saveEditor(cx))));
  }
}
