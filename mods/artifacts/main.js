import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, checking, closeOverlay, exec, layout, machines, notify, openOverlay, props, run, setShared, shared, theme } from "herdr";
import {
  HTML, LISTEN, capture, freePort, hash, investigate, launch, stopProcs, loadRegistry, openInChrome, parseHtml, parseListeners,
  probe, reach, reachable, running, sh, slug, stop, updateRegistry, urlFor,
} from "./data.js";

const EVERY_MS = 10000;
const SCAN_MS = 60000;
const ICON = (name) => `mods/artifacts/${name}.svg`;
// Module state is shared by every copy of the page, so two copies never shoot the same thing at once.
const shooting = new Set();
const shots = () => shared("artifacts.shots") ?? {};

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
    this.shotThisRun = new Set();
    this.armed = null;
    this.tab = p.tab ?? localStorage.getItem("artifacts.tab") ?? "apps";
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
        await Promise.all(live.filter((r) => r.kind !== "tunnel").map(async (r) => { if (await probe(r.machine, r.port)) ready.add(r.address); }));
        this.ready = ready;
        this.autoShots(cx);
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
        if (l) {
          const found = parseListeners(l.stdout, m.name);
          await Promise.all(found.map(async (p) => { p.direct = !m.name || (p.http.length > 0 && (await reachable(urlFor(m.name, p.port)))); }));
          this.listeners[k] = found;
        }
        if (h) this.html[k] = parseHtml(h.stdout, m.name);
        this.autoShots(cx);
        cx.notify();
      });
    }
  }

  // Screenshots

  shot(key) {
    return shots()[key]?.path ?? null;
  }

  takeShot(key, target, cx) {
    if (shooting.has(key)) return;
    shooting.add(key);
    this.shotThisRun.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const url = typeof target === "function" ? await target() : target;
        const path = await capture(appHome(), key, url);
        const all = shots();
        const old = all[key]?.path;
        setShared("artifacts.shots", { ...all, [key]: { path, at: Date.now() } });
        if (old) exec("rm", ["-f", `${appHome()}/${old}`]).catch(() => null);
      } catch {}
      shooting.delete(key);
      cx.notify();
    });
  }

  // Running apps once per run, reachable discovered servers and local HTML when there's no picture yet (or the file changed).
  autoShots(cx) {
    for (const app of this.registry.apps) {
      const r = this.liveApp(app);
      const key = `app:${app.id}`;
      if (r && this.ready.has(r.address) && !this.shotThisRun.has(key)) this.takeShot(key, () => reach(app.machine, r.port, this.live).then((u) => u + (app.path ?? "/")), cx);
    }
    for (const p of Object.values(this.listeners).flat()) {
      const key = `disc:${p.machine ?? "local"}:${p.port}`;
      if (p.direct && p.http.length && !this.shot(key) && !this.shotThisRun.has(key)) this.takeShot(key, urlFor(p.machine, p.http[0]), cx);
    }
    for (const h of this.html.local ?? []) {
      const key = `html:${h.id}`;
      if ((!this.shot(key) || shots()[key].at < h.mtime) && !this.shotThisRun.has(key)) this.takeShot(key, `file://${h.main}`, cx);
    }
  }

  // State and actions

  liveApp(app) {
    return this.live.find((r) => r.kind === "app" && r.id === app.id && r.machine === (app.machine ?? null));
  }

  // A discovered server running out of the app's folder that Herdr didn't start.
  outside(app) {
    const f = app.folder;
    const within = (a, b) => a === b || a.startsWith(`${b}/`);
    return (this.listeners[app.machine ?? "local"] ?? []).find((g) =>
      (within(f, g.repo) && g.procs.some((p) => within(p.cwd, f) || within(f, p.cwd)))
      && !this.live.some((r) => r.machine === (app.machine ?? null) && g.ports.includes(r.port)));
  }

  // Discovered servers that aren't a saved app or one Herdr started.
  unsaved() {
    const within = (a, b) => a === b || a?.startsWith(`${b}/`);
    return Object.values(this.listeners).flat().filter((g) =>
      !this.registry.apps.some((a) => (a.machine ?? null) === g.machine && within(a.folder, g.repo))
      && !this.live.some((r) => r.machine === g.machine && g.ports.includes(r.port)));
  }

  stopOutside(g, key, cx) {
    this.busy(key, cx, async () => {
      await stopProcs(g.machine, g.procs);
      const k = g.machine ?? "local";
      this.listeners[k] = (this.listeners[k] ?? []).filter((x) => x.id !== g.id);
      this.scannedAt = 0;
    });
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
      this.shotThisRun.delete(`app:${app.id}`);
    });
  }

  stopIt(r, key, cx) {
    this.busy(key, cx, () => stop(r.address));
  }

  open(machine, port, path, key, cx) {
    this.busy(key, cx, async () => openInChrome((await reach(machine, port, this.live)) + (path ?? "/")));
  }

  // Local files open straight in Chrome; another machine's folder gets a static server first.
  openHtml(item, cx) {
    if (!item.machine) return void openInChrome(item.main);
    const file = item.main.slice(item.dir.length);
    const r = this.liveHtml(item);
    this.busy(item.id, cx, async () => {
      let port = r?.port;
      if (!port) {
        port = await freePort(item.machine);
        await launch(`html-${hash(item.dir)}-${port}`, item.machine, item.dir, 'exec python3 -m http.server "$PORT" --bind 0.0.0.0', port);
        for (let i = 0; i < 20 && !(await probe(item.machine, port)); i++) await exec("sleep", ["0.25"]);
      }
      const url = (await reach(item.machine, port, this.live)) + file;
      await openInChrome(url);
      if (!this.shot(`html:${item.id}`)) this.takeShot(`html:${item.id}`, url, cx);
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

  setTab(tab, cx) {
    this.tab = tab;
    localStorage.setItem("artifacts.tab", tab);
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
      .when(Boolean(icon), (el) => el.child(icon === "spinner" ? svg(ICON(icon)).size(11).spin(900) : svg(ICON(icon)).size(11)))
      .when(Boolean(label), (el) => el.child(label));
  }

  primary(id, icon, label, action, t) {
    return h_flex().id(id).h(28).px(11).gap(6).items_center().rounded(7).cursor_pointer()
      .bg(t.solid).text_color(t.solid_foreground).text_size(12).font_medium()
      .hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => action(cx))
      .child(svg(ICON(icon)).size(12)).child(label);
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
    return div().max_w(270).truncate().px(6).py(1).rounded(5).bg(t.background).border_1().border_color(t.border)
      .text_size(10.5).text_color(color ?? t.dim).flex_none().child(text);
  }

  tabs(t) {
    const count = (n) => (n ? ` ${n}` : "");
    const html = Object.values(this.html).flat().length + this.registry.links.length;
    const listeners = this.unsaved().length;
    const seg = (value, label) => div().id(`tab-${value}`).px(10).h(24).flex().items_center().rounded(5).cursor_pointer()
      .text_size(11.5).text_color(this.tab === value ? t.foreground : t.muted).when(this.tab === value, (el) => el.bg(t.raised))
      .on_click((_e, cx) => this.setTab(value, cx))
      .child(label);
    return h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border).bg(t.background)
      .child(seg("apps", `Apps${count(this.registry.apps.length)}`))
      .child(seg("artifacts", `Claude artifacts${count(html)}`))
      .child(seg("discover", `Discover${count(listeners)}`));
  }

  // A Plugins-style card: picture on top, then title, switch, description, badges and buttons.
  card(id, { key, title, sub, description, badges, toggle, buttons, placeholder, retake, dim }, t) {
    const path = key ? this.shot(key) : null;
    const taking = key && shooting.has(key);
    const picture = div().h(168).w_full().flex_none().bg(t.background).border_b_1().border_color(t.border).overflow_hidden()
      .flex().items_center().justify_center()
      .child(path ? image(path).w_full().h(168)
        : taking ? svg(ICON("spinner")).size(18).text_color(t.dim).spin(900)
        : placeholder ? svg(ICON(placeholder)).size(30).text_color(t.border)
        : div().text_size(32).font_semibold().text_color(t.border).child((title || "?").slice(0, 1).toUpperCase()));
    return v_flex().id(`card-${id}`).w(300).flex_none().rounded(12).bg(t.surface).border_1().border_color(t.border).overflow_hidden()
      .when(Boolean(dim), (el) => el.opacity(0.7))
      .child(picture)
      .child(v_flex().gap(6).p(14)
        .child(h_flex().gap(8).items_center()
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(14).font_semibold().text_color(t.foreground).truncate().child(title))
            .when(Boolean(sub), (el) => el.child(sub)))
          .when(Boolean(toggle), (el) => el.child(toggle)))
        .when(Boolean(description), (el) => el.child(typeof description === "string" ? div().text_size(12).text_color(t.muted).max_h(34).overflow_hidden().child(description) : description))
        .when(badges?.length > 0, (el) => el.child(h_flex().flex_wrap().gap(5).pt(2).children(badges)))
        .when(buttons?.length > 0 || Boolean(retake), (el) => el.child(h_flex().pt(4).gap(5).flex_wrap()
          .children(buttons ?? [])
          .when(Boolean(retake), (x) => x.child(div().flex_1()).child(this.button(`shot-${id}`, taking ? "spinner" : "camera", null, retake, t))))));
  }

  subline(machine, text, t) {
    return h_flex().gap(6).items_center().min_w(0)
      .child(machineChip(machine, t))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(text));
  }

  gallery(title, extra, cards, t, empty) {
    return v_flex().gap(12)
      .when(Boolean(title), (el) => el.child(h_flex().gap(8).items_baseline()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
        .when(Boolean(extra), (x) => x.child(div().text_size(12).text_color(t.dim).child(extra)))))
      .child(cards.length ? h_flex().flex_wrap().items_start().gap(14).children(cards)
        : div().text_size(12.5).text_color(t.dim).child(empty));
  }

  appCard(app, t) {
    const r = this.liveApp(app);
    const ext = r ? null : this.outside(app);
    const busy = this.pending.has(app.id);
    const ready = r && this.ready.has(r.address);
    const deleting = this.armed === `del:${app.id}`;
    const key = ext ? `disc:${app.machine ?? "local"}:${ext.port}` : `app:${app.id}`;
    const port = r?.port ?? ext?.http[0];
    const badges = [
      r ? this.badge(ready ? `running · ${app.machine ?? "localhost"}:${r.port}` : `starting on port ${r.port}…`, t, ready ? t.done : t.working)
        : ext ? this.badge(`running outside Herdr · ${app.machine ?? "localhost"}:${ext.ports.join(", ")}`, t, t.done)
        : this.badge(app.port ? `port ${app.port}` : "any free port", t),
    ];
    const buttons = [
      port && this.button(`open-${app.id}`, "external", "Open", (cx) => this.open(app.machine, port, app.path, app.id, cx), t, "accent"),
      r && this.button(`logs-${app.id}`, "logs", "Logs", () => run("terminal.peek", { terminal: r.address }), t),
      this.button(`edit-${app.id}`, "pencil", "Edit", () => this.edit("app", app), t),
      deleting
        ? this.button(`del-${app.id}`, "x", "Remove?", (cx) => this.remove("apps", app.id, cx), t, "danger")
        : this.button(`del-${app.id}`, "x", null, (cx) => { this.armed = `del:${app.id}`; cx.notify(); }, t),
    ].filter(Boolean);
    const what = ext?.procs.map((p) => (p.docker ? `docker compose -p ${p.docker} stop` : `kill ${p.pid}`)).join(", ");
    const tip = r ? "Stop it" : ext ? `Stop it (${what})` : "Start it";
    const flip = (cx) => (r ? this.stopIt(r, app.id, cx) : ext ? this.stopOutside(ext, app.id, cx) : this.start(app, cx));
    return this.card(`app-${app.id}`, {
      key, title: app.name, sub: this.subline(app.machine ?? null, tilde(app.folder), t),
      description: app.notes || app.command, badges, buttons,
      toggle: this.toggle(app.id, Boolean(r || ext), busy, tip, flip, t),
      retake: ready || ext?.http.length ? (cx) => this.takeShot(key, () => reach(app.machine, port, this.live).then((u) => u + (app.path ?? "/")), cx) : null,
      dim: !r && !ext,
    }, t);
  }

  discoverCard(p, t) {
    const looking = this.investigating.has(p.id);
    const key = `disc:${p.machine ?? "local"}:${p.port}`;
    const badges = [
      p.machine && p.http.length > 0 && !p.direct && this.badge(`only on ${p.machine}: opens through ssh`, t),
    ].filter(Boolean);
    const buttons = [
      p.http.length > 0 && this.button(`dopen-${p.id}`, this.pending.has(p.id) ? "spinner" : "external", "Open", (cx) => this.open(p.machine, p.http[0], "/", p.id, cx), t),
      this.button(`dsave-${p.id}`, looking ? "spinner" : "sparkle", looking ? "Working it out…" : "Save as app", (cx) => { if (!looking) this.save(p, cx); }, t, "accent"),
    ].filter(Boolean);
    return this.card(`disc-${p.id}`, {
      key, title: p.repo.split("/").pop(), sub: this.subline(p.machine, tilde(p.repo), t),
      description: v_flex().gap(4).children(p.procs.map((x) => this.procRow(p, x, t))), badges, buttons,
      retake: p.http.length > 0 ? (cx) => this.takeShot(key, () => reach(p.machine, p.http[0], this.live), cx) : null,
      placeholder: p.http.length ? null : "server",
    }, t);
  }

  // A process in a discovered repo: where it runs, its command, and its ports (http ones open on click).
  procRow(g, x, t) {
    const where = x.cwd === g.repo ? "" : `${x.cwd.slice(g.repo.length + 1)}  `;
    return v_flex().gap(3).min_w(0)
      .child(div().text_size(11).text_color(t.muted).truncate().child(`${where}${x.args}`))
      .child(h_flex().gap(4).flex_wrap().children(x.ports.map((port) => x.http.includes(port)
        ? div().id(`port-${g.id}-${port}`).px(6).py(1).rounded(5).cursor_pointer().bg(t.background).border_1().border_color(t.border)
          .text_size(10.5).text_color(t.accent).hover((s) => s.bg(t.hover)).tooltip(`Open port ${port}`)
          .on_click((_e, cx) => this.open(g.machine, port, "/", `${g.id}:${port}`, cx)).child(`:${port}`)
        : this.badge(`:${port} · not http`, t))));
  }

  htmlCard(item, t) {
    const r = item.machine ? this.liveHtml(item) : null;
    const busy = this.pending.has(item.id);
    const key = `html:${item.id}`;
    const more = item.files.length > 1 ? [this.badge(`+${item.files.length - 1} more file${item.files.length > 2 ? "s" : ""}`, t)] : [];
    const buttons = [
      this.button(`hopen-${item.id}`, busy ? "spinner" : "external", "Open", (cx) => this.openHtml(item, cx), t, "accent"),
      r && this.button(`hstop-${item.id}`, "pause", "Stop server", (cx) => this.stopIt(r, item.id, cx), t),
    ].filter(Boolean);
    return this.card(`html-${item.id}`, {
      key, title: item.main.split("/").pop(), sub: this.subline(item.machine, since(item.mtime), t), description: tilde(item.dir),
      badges: [...more, ...(r ? [this.badge(`served on port ${r.port}`, t, t.done)] : [])], buttons,
      retake: !item.machine ? (cx) => this.takeShot(key, `file://${item.main}`, cx) : null,
      placeholder: "file",
    }, t);
  }

  linkCard(link, t) {
    const deleting = this.armed === `del:${link.id}`;
    const buttons = [
      this.button(`lopen-${link.id}`, "external", "Open", () => openInChrome(link.url), t, "accent"),
      this.button(`ledit-${link.id}`, "pencil", "Edit", () => this.edit("link", link), t),
      deleting
        ? this.button(`ldel-${link.id}`, "x", "Remove?", (cx) => this.remove("links", link.id, cx), t, "danger")
        : this.button(`ldel-${link.id}`, "x", null, (cx) => { this.armed = `del:${link.id}`; cx.notify(); }, t),
    ];
    return this.card(`link-${link.id}`, {
      title: link.name, sub: div().text_size(11.5).text_color(t.dim).truncate().child(link.url.replace(/^https?:\/\//, "")),
      buttons, placeholder: "link",
    }, t);
  }

  body(t) {
    if (this.tab === "discover") {
      const list = this.unsaved().sort((a, b) => (b.http.length > 0) - (a.http.length > 0));
      return this.gallery(null, null, list.map((p) => this.discoverCard(p, t)), t, "Nothing new is listening on your machines. Saved apps are under Apps.");
    }
    if (this.tab === "artifacts") {
      const html = Object.values(this.html).flat().sort((a, b) => b.mtime - a.mtime);
      return v_flex().gap(28)
        .child(this.gallery("Pinned", "claude.ai artifacts and other links", this.registry.links.map((l) => this.linkCard(l, t)), t, "Nothing pinned yet. Pin a link from claude.ai."))
        .child(this.gallery("From Claude sessions", "HTML that sessions wrote in the last 30 days", html.map((h) => this.htmlCard(h, t)), t, "No HTML files from Claude sessions found."));
    }
    return this.gallery(null, null, this.registry.apps.map((a) => this.appCard(a, t)), t,
      "No apps yet. Add one, or find a running one under Discover and save it.");
  }

  actions(t) {
    if (this.tab === "apps") return [this.primary("add-app", "plus", "Add app", () => this.edit("app", null), t)];
    if (this.tab === "artifacts") return [
      this.button("open-claude-artifacts", "external", "claude.ai/artifacts", () => openInChrome("https://claude.ai/artifacts"), t),
      this.primary("pin-link", "link", "Pin link", () => this.edit("link", null), t),
    ];
    return [];
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
    return v_flex().size_full().min_h(0).bg(t.canvas)
      .child(h_flex().h(42).flex_none().px(20).gap(10).items_center().bg(t.chrome).border_b_1().border_color(t.border)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Artifacts"))
        .child(this.tabs(t))
        .child(div().flex_1())
        .children(this.actions(t))
        .child(this.button("refresh", "reset", "Refresh", (cx) => this.refresh(cx, true), t)))
      .when(Boolean(this.error), (el) => el.child(div().px(20).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().id("artifacts-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().p(20).child(this.body(t))));
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
