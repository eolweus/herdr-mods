import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, appHome, checking, exec, layout, machines, panes, readTextFile, run, setShared, shared, spaces, theme, writeTextFile } from "herdr";
import { SESSIONS, STATS, agentOf, children, describe, isClaude, isShell, parseSessions, parseStats, terminalOf } from "./stats.js";

const EVERY_MS = 4000;
const SESSIONS_MS = 10000;

// The same palette as space avatars; spaces-tree reads machine-colors.json into shared "machine.colors".
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// Ports whose owner the user can't see (root's sshd, resolved, ...).
const WELL_KNOWN = { 22: "ssh", 53: "dns", 80: "http", 443: "https", 631: "cups", 5432: "postgres", 6379: "redis", 3306: "mysql", 27017: "mongodb" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

const shown = () => find(layout(), "work-stack")?.active === "machines-view";

const bytes = (n) => {
  if (!Number.isFinite(n)) return "–";
  const u = ["B", "K", "M", "G", "T"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${u[i]}`;
};

const ago = (secs) => {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

// Claude Code renames its process to its version ("2.1.325-1ef04b3"); the command line says what it is.
const VERSION_TITLE = /^\d+\.\d+\.\d+(-[0-9a-f]+)?$/;
const procName = (name, args) => {
  const first = args?.split(" ")[0]?.split("/").pop();
  if (VERSION_TITLE.test(name ?? "") || VERSION_TITLE.test(first ?? "")) return "claude";
  return name || first || "?";
};

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// The Herdr agent in a terminal: its chat title, else its tab, with the space it's in.
function agentIn(m, tid) {
  if (!tid) return null;
  const address = m.name ? `${m.name}/${tid}` : tid;
  const a = agents().find((x) => x.address === address);
  if (!a) return { address, label: `terminal ${tid}` };
  const live = clean(a.title);
  const title = live && !/^\d+$/.test(live) && live !== a.program?.name ? live : !/^\d+$/.test(a.tab_name ?? "") && a.tab_name ? a.tab_name : a.program?.name ?? tid;
  return { address, label: `${a.space_name} · ${title}`, status: a.status };
}

// Claude's MCP servers, language servers and the agent's own one-off commands: not what it "started".
const HELPER = /mcp|typescript|language-server|caffeinate|^(sleep|ps|awk|head|tail|cut|grep|ugrep|rg|sed|tr|git|find|ls|cat|wc|jq)$/;
const helper = (p) => HELPER.test(describe(p));

// A session outside Herdr, named by its project: "my-repo · fix-login" for a worktree.
function project(cwd) {
  if (!cwd) return "unknown folder";
  if (cwd.includes("/Application Support/Claude/")) return "Claude app";
  const wt = /\/([^/]+)(?:\/worktrees\/[^/]+)?(?:\/\.claude)?\/worktrees\/([^/]+)/.exec(cwd);
  if (wt) return `${wt[1]} · ${wt[2].replace(/-[0-9a-f]{6}$/, "")}`;
  return cwd.split("/").pop();
}

const tokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const since = (ms) => (Date.now() - ms < 60000 ? "now" : `${ago((Date.now() - ms) / 1000)} ago`);
const modelName = (id) => {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id ?? "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id?.replace(/^claude-/, "") ?? null;
};
const flag = (args, name) => new RegExp(`--${name}[= ](\\S+)`).exec(args ?? "")?.[1] ?? null;
const ENTRY = { "claude-desktop": "Claude app", cli: "Terminal", "sdk-ts": "Agent SDK", "sdk-py": "Agent SDK" };

// herdr-chat panes publish their session to shared "herdr-chat:info:<pane>".
function herdrChats(machine) {
  const out = new Map();
  for (const p of panes()) {
    if (p.mod !== "herdr-chat") continue;
    const info = shared(`herdr-chat:info:${p.pane}`);
    if (info?.session && (info.machine ?? null) === machine) out.set(info.session, { pane: p.pane, tab: p.tab, info });
  }
  return out;
}

function tabLabel(tabId) {
  for (const sp of spaces()) for (const tab of sp.tabs) if (tab.id === tabId) return `${sp.name} · ${tab.name}`;
  return null;
}

const mine = (p, home) => Number(Boolean(p.docker || (home && p.cwd?.startsWith(home))));
const short = (path, home) => (path && home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);

export default class Machines extends View {
  init(_props, cx) {
    this.stats = {};
    this.errors = {};
    this.busy = new Set();
    this.sessions = {};
    this.sessionsAt = {};
    this.opened = new Set();
    try { this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]")); } catch { this.folded = new Set(); }
    if (checking()) return;
    cx.timer.every(EVERY_MS, (cx) => this.poll(cx));
  }

  key(m) { return m.name ?? "local"; }

  // machine-colors.json may be a symlink (dotfiles); write through it so the link survives.
  async setColor(k, name) {
    const link = `${appHome()}/machine-colors.json`;
    const real = (await exec("realpath", [link]).catch(() => null))?.stdout.trim() || link;
    const before = await readTextFile(real);
    let map = {};
    try { map = JSON.parse(before ?? "{}"); } catch {}
    if (name) map[k] = name;
    else delete map[k];
    await writeTextFile(real, `${JSON.stringify(map, null, 2)}\n`, before);
    const hex = { ...(shared("machine.colors") ?? {}) };
    if (name) hex[k] = MARK[name];
    else delete hex[k];
    setShared("machine.colors", hex);
  }

  swatches(k, t) {
    const now = (shared("machine.colors") ?? {})[k] ?? null;
    const swatch = (name, fill) => div().id(`color-${k}-${name ?? "none"}`).size(16).rounded(8).cursor_pointer()
      .border_2().border_color((name ? MARK[name] : null) === now ? t.foreground : "#00000000")
      .when(Boolean(fill), (el) => el.bg(fill)).when(!fill, (el) => el.border_1().border_color(now ? t.dim : t.foreground))
      .tooltip(name ? "Color this machine everywhere" : "No color")
      .on_click((_e, cx) => { cx.stop_propagation(); this.setColor(k, name).catch(() => {}); cx.notify(); });
    return h_flex().gap(5).items_center().flex_none()
      .child(swatch(null, null))
      .children(Object.entries(MARK).map(([name, fill]) => swatch(name, fill)));
  }

  poll(cx) {
    if (!shown()) return;
    for (const m of machines()) {
      if (m.layout === "unavailable" || m.temporary) continue;
      const k = this.key(m);
      if (this.busy.has(k)) continue;
      this.busy.add(k);
      cx.spawn(async (cx) => {
        try {
          const r = await exec("sh", ["-c", STATS], { on: m.name, timeout: 15000 });
          this.stats[k] = { ...parseStats(r.stdout), at: Date.now() };
          delete this.errors[k];
        } catch (e) {
          this.errors[k] = String(e?.message ?? e);
        }
        this.busy.delete(k);
        cx.notify();
      });
      if (this.folded.has(`${k}:agents`) || this.busy.has(`${k}:sessions`) || Date.now() - (this.sessionsAt[k] ?? 0) < SESSIONS_MS) continue;
      this.busy.add(`${k}:sessions`);
      cx.spawn(async (cx) => {
        try {
          const r = await exec("sh", ["-c", SESSIONS], { on: m.name, timeout: 15000 });
          this.sessions[k] = parseSessions(r.stdout);
        } catch {}
        this.sessionsAt[k] = Date.now();
        this.busy.delete(`${k}:sessions`);
        cx.notify();
      });
    }
  }

  gauge(label, pct, value, detail, t) {
    const p = Math.max(0, Math.min(100, pct || 0));
    const color = p > 90 ? t.blocked : p > 70 ? t.working : t.accent;
    return v_flex().flex_1().min_w(110).gap(6).p(12).rounded(9).bg(t.background).border_1().border_color(t.border)
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(11.5).text_color(t.muted).child(label))
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child(value)))
      .child(div().h(5).w_full().rounded(3).bg(t.border).child(div().h_full().w(`${p}%`).rounded(3).bg(color)))
      .child(div().text_size(11).text_color(t.dim).truncate().child(detail));
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    try { localStorage.setItem("folded", JSON.stringify([...this.folded])); } catch {}
    cx.notify();
  }

  section(id, text, extra, content, t) {
    const open = !this.folded.has(id);
    const head = h_flex().id(`fold-${id}`).gap(7).items_center().pt(4).pb(1).rounded(5).cursor_pointer()
      .hover((st) => st.text_color(t.foreground))
      .on_click((_e, cx) => this.fold(id, cx))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.dim))
      .child(div().text_size(12).font_medium().text_color(t.muted).child(text))
      .when(extra != null, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(extra)));
    return open ? [head, ...content] : [head];
  }

  cell(width, child, t, color) {
    const el = div().text_size(12).truncate().text_color(color ?? t.foreground).child(child);
    return width ? el.w(width).flex_none() : el.flex_1().min_w(0);
  }

  portsTable(m, s, home, t) {
    const host = m.name ?? "localhost";
    const ports = [...s.ports].sort((a, b) => mine(b, home) - mine(a, home) || a.port - b.port);
    const head = h_flex().gap(12).px(10).pb(4).border_b_1().border_color(t.border)
      .child(this.cell(64, "Port", t, t.dim)).child(this.cell(200, "Process", t, t.dim)).child(this.cell(70, "PID", t, t.dim))
      .child(this.cell(null, "What", t, t.dim)).child(this.cell(52, "Scope", t, t.dim));
    return v_flex().gap(1).child(head).children(ports.map((p) => {
      const name = p.docker ?? (p.pid ? this.name(s, p.pid, procName(p.name, p.args)) : WELL_KNOWN[p.port] ?? "system");
      const what = p.docker ? `docker container → :${p.inner}` : [p.pid && this.context(m, s, p.pid), short(p.cwd !== "/" ? p.cwd : null, home), p.args].filter(Boolean).join("  ·  ") || "–";
      return h_flex().id(`port-${this.key(m)}-${p.port}`).gap(12).px(10).py(5).rounded(6).items_center().cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click(() => exec("open", [`http://${host}:${p.port}`]).catch(() => {}))
        .child(this.cell(64, `:${p.port}`, t, p.public ? t.foreground : t.muted).font_medium())
        .child(this.cell(200, name, t))
        .child(this.cell(70, p.pid ?? "–", t, t.dim))
        .child(this.cell(null, what, t, t.muted))
        .child(this.cell(52, p.public ? "open" : "local", t, p.public ? t.working : t.dim));
    }));
  }

  // Who a process belongs to: the Claude that started it, else the Herdr terminal it runs in.
  context(m, s, pid) {
    const owner = agentOf(s, pid);
    const where = agentIn(m, terminalOf(s, owner?.pid ?? pid));
    if (owner) return `by Claude · ${where?.label ?? project(owner.cwd)}`;
    if (where) return `in ${where.label}`;
    const self = s.procs.get(String(pid));
    return isClaude(self) ? `Claude outside Herdr · ${project(self.cwd)}` : null;
  }

  name(s, pid, fallback) {
    const p = s.procs.get(String(pid));
    return p ? describe(p, fallback) : procName(fallback);
  }

  agentsSection(m, s, home, t) {
    const kids = children(s);
    const portsBy = new Map();
    for (const p of s.ports) if (p.pid) portsBy.set(p.pid, [...(portsBy.get(p.pid) ?? []), p.port]);
    const claudes = [...s.procs.values()].filter((p) => isClaude(p) && !agentOf(s, p.pid));
    if (!claudes.length) return null;
    const descendants = (pid) => {
      const out = [];
      const walk = (id, depth) => {
        for (const c of kids.get(id) ?? []) {
          if (!isShell(c)) out.push(c);
          if (depth < 12) walk(c.pid, depth + 1);
        }
      };
      walk(pid, 0);
      return out;
    };
    const rows = claudes.map((c) => {
      const where = agentIn(m, terminalOf(s, c.pid));
      const all = descendants(c.pid).filter((p) => portsBy.has(p.pid) || !helper(p));
      const busy = all.reduce((sum, p) => sum + p.cpu, c.cpu);
      return { c, where, all, busy };
    }).sort((a, b) => Number(Boolean(b.where)) - Number(Boolean(a.where)) || b.busy - a.busy);
    const quiet = rows.filter((r) => !r.where && !r.all.length);
    const counts = {};
    for (const r of quiet) { const k = project(r.c.cwd); counts[k] = (counts[k] ?? 0) + 1; }
    return { extra: `${claudes.length} Claude sessions · what each started`, content: [
      v_flex().gap(8).children(rows.filter((r) => !quiet.includes(r)).map(({ c, where, all, busy }) => {
        const shownKids = [...all].sort((a, b) => Number(portsBy.has(b.pid)) - Number(portsBy.has(a.pid)) || b.cpu - a.cpu);
        const color = where?.status === "blocked" ? t.blocked : where?.status === "working" ? t.working : where?.status === "done" ? t.done : t.dim;
        return v_flex().p(10).rounded(9).bg(t.background).border_1().border_color(t.border).gap(2)
          .child(h_flex().id(`agent-${this.key(m)}-${c.pid}`).gap(10).items_center().px(4).py(2).rounded(6)
            .when(Boolean(where), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => run("pane.focus", { terminal: where.address })))
            .child(div().size(7).rounded(4).flex_none().bg(color))
            .child(v_flex().flex_1().min_w(0)
              .child(div().text_size(12.5).font_medium().truncate().text_color(t.foreground).child(where?.label ?? `${project(c.cwd)} (outside Herdr)`))
              .child(div().text_size(11).truncate().text_color(t.dim).child(`pid ${c.pid} · ${short(c.cwd, home) ?? "?"}`)))
            .child(this.cell(110, `${busy.toFixed(1)}% CPU`, t, busy > 50 ? t.working : t.muted))
            .child(this.cell(70, bytes(all.reduce((sum, p) => sum + p.rss, c.rss)), t, t.muted)))
          .children(shownKids.slice(0, 8).map((p) => h_flex().gap(12).pl(22).pr(4).py(2).items_center()
            .child(this.cell(null, describe(p), t, t.foreground))
            .child(this.cell(110, portsBy.has(p.pid) ? portsBy.get(p.pid).map((x) => `:${x}`).join(" ") : "", t, t.accent))
            .child(this.cell(64, p.pid, t, t.dim))
            .child(this.cell(56, `${p.cpu.toFixed(1)}%`, t, p.cpu > 50 ? t.working : t.muted))))
          .when(shownKids.length > 8, (el) => el.child(div().pl(22).text_size(11).text_color(t.dim).child(`+${shownKids.length - 8} more`)))
          .when(!shownKids.length, (el) => el.child(div().pl(22).text_size(11).text_color(t.dim).child("nothing running")));
      })),
      ...(quiet.length ? [div().px(10).text_size(11.5).text_color(t.dim)
        .child(`${quiet.length} more outside Herdr with nothing running: ${Object.entries(counts).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ")}`)] : []),
    ] };
  }

  sessionsSection(m, s, list, home, t) {
    const k = this.key(m);
    const kids = children(s);
    const tree = (pid) => {
      const out = [];
      const walk = (id, depth) => { for (const c of kids.get(id) ?? []) { out.push(c); if (depth < 12) walk(c.pid, depth + 1); } };
      walk(pid, 0);
      return out;
    };
    const chats = herdrChats(m.name);
    const rows = list.map((r) => {
      const proc = s.procs.get(String(r.pid));
      if (!proc || !isClaude(proc)) return null;
      const procs = tree(proc.pid);
      const chat = chats.get(r.sessionId);
      const term = chat ? null : agentIn(m, terminalOf(s, r.pid));
      const where = chat ? { kind: "Herdr chat", label: tabLabel(chat.tab), focus: { pane: chat.pane } }
        : term ? { kind: "Herdr terminal", label: term.label, focus: { terminal: term.address } }
        : { kind: ENTRY[r.entrypoint] ?? r.entrypoint ?? "Claude Code", label: null, focus: null };
      const j = r.transcript;
      const max = chat?.info?.context?.max || null;
      return {
        r, proc, procs, where, chat,
        busy: r.status === "busy",
        title: r.name || chat?.info?.title || project(r.cwd),
        mem: procs.reduce((n, p) => n + p.rss, proc.rss),
        cpu: procs.reduce((n, p) => n + p.cpu, proc.cpu),
        model: modelName(flag(proc.args, "model") ?? j?.model ?? chat?.info?.model),
        effort: flag(proc.args, "effort"),
        mode: chat?.info?.mode ?? flag(proc.args, "permission-mode"),
        context: j?.context || chat?.info?.context?.used || 0, max,
        branch: j?.branch && j.branch !== "HEAD" ? j.branch : chat?.info?.branch ?? null,
        last: Math.max(r.updatedAt ?? 0, r.statusUpdatedAt ?? 0, j?.mtime ?? 0, r.startedAt ?? 0),
      };
    }).filter(Boolean).sort((a, b) => Number(b.busy) - Number(a.busy) || b.last - a.last);
    if (!rows.length) return null;
    const resting = [...chats.keys()].filter((id) => !rows.some((x) => x.r.sessionId === id)).length;
    const total = rows.reduce((n, x) => n + x.mem, 0);
    const working = rows.filter((x) => x.busy).length;
    const stale = rows.filter((x) => !x.busy && Date.now() - x.last > 86400000).length;
    const extra = [`${rows.length} running`, working && `${working} working`, bytes(total), stale && `${stale} idle over a day`].filter(Boolean).join(" · ");

    const head = h_flex().gap(12).px(10).pb(4).border_b_1().border_color(t.border)
      .child(this.cell(null, "Session", t, t.dim)).child(this.cell(120, "Model", t, t.dim))
      .child(this.cell(84, "Context", t, t.dim)).child(this.cell(60, "Memory", t, t.dim))
      .child(this.cell(52, "CPU", t, t.dim)).child(this.cell(76, "Active", t, t.dim));
    const row = (x) => {
      const id = `${k}:${x.r.pid}`;
      const open = this.opened.has(id);
      const dot = x.busy ? t.working : x.chat?.info && x.r.status === "idle" && Date.now() - x.last < 600000 ? t.done : t.dim;
      const sub = [x.where.kind, x.where.label ?? short(x.r.cwd, home), x.branch].filter(Boolean).join(" · ");
      const ctx = x.context ? (x.max ? `${tokens(x.context)} · ${Math.round((100 * x.context) / x.max)}%` : tokens(x.context)) : "–";
      const line = h_flex().id(`session-${id}`).gap(12).px(10).py(5).rounded(6).items_center().cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { this.opened.has(id) ? this.opened.delete(id) : this.opened.add(id); cx.notify(); })
        .child(div().size(7).rounded(4).flex_none().bg(dot))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12.5).font_medium().truncate().text_color(t.foreground).child(x.title))
          .child(div().text_size(11).truncate().text_color(t.dim).child(sub)))
        .child(this.cell(120, [x.model, x.effort].filter(Boolean).join(" · ") || "–", t, t.muted))
        .child(this.cell(84, ctx, t, x.max && x.context / x.max > 0.8 ? t.working : t.muted))
        .child(this.cell(60, bytes(x.mem), t, x.mem > 1.5 * 2 ** 30 ? t.working : t.muted))
        .child(this.cell(52, `${x.cpu.toFixed(1)}%`, t, x.cpu > 50 ? t.working : t.muted))
        .child(this.cell(76, x.busy ? "working" : since(x.last), t, x.busy ? t.working : t.muted));
      if (!open) return line;
      // Each thing Claude started, with everything it started in turn; a shell is named by what runs in it.
      const groups = new Map();
      for (const c of kids.get(x.proc.pid) ?? []) {
        const sub = [c, ...tree(c.pid)];
        const work = sub.filter((p) => !isShell(p)).sort((a, b) => b.rss - a.rss)[0];
        const name = isShell(c) ? (work ? describe(work) : "shell") : describe(c);
        const g = groups.get(name) ?? { name, rss: 0, cpu: 0, n: 0 };
        for (const p of sub) { g.rss += p.rss; g.cpu += p.cpu; g.n += 1; }
        groups.set(name, g);
      }
      const proc = (name, n, rss, cpu) => h_flex().gap(12).py(2).items_center()
        .child(this.cell(null, name, t, t.foreground))
        .child(this.cell(120, n > 1 ? `${n} processes` : "", t, t.dim))
        .child(div().w(84).flex_none())
        .child(this.cell(60, bytes(rss), t, t.muted))
        .child(this.cell(52, `${cpu.toFixed(1)}%`, t, cpu > 50 ? t.working : t.muted))
        .child(div().w(76).flex_none());
      const facts = [
        `pid ${x.r.pid}`, x.r.version && `v${x.r.version}`, x.r.startedAt && `up ${ago((Date.now() - x.r.startedAt) / 1000)}`,
        x.mode && `${x.mode} mode`, x.r.bridgeSessionId && "Remote Control on",
      ].filter(Boolean).join(" · ");
      const detail = v_flex().gap(2).pl(29).pr(10).pb(8)
        .child(h_flex().gap(10).items_center().pb(4)
          .child(div().flex_1().min_w(0).text_size(11).truncate().text_color(t.dim).child(`${short(x.r.cwd, home)} · ${facts}`))
          .when(Boolean(x.where.focus), (el) => el.child(div().id(`focus-${id}`).flex_none().text_size(11.5).text_color(t.accent).cursor_pointer()
            .hover((st) => st.opacity(0.8)).on_click(() => run("pane.focus", x.where.focus)).child("Show"))))
        .child(proc("Claude Code", 1, x.proc.rss, x.proc.cpu))
        .children([...groups.values()].sort((a, b) => b.rss - a.rss).slice(0, 10).map((g) => proc(g.name, g.n, g.rss, g.cpu)));
      return v_flex().rounded(6).bg(t.background).child(line).child(detail);
    };
    return { extra, content: [v_flex().gap(1).child(head).children(rows.map(row))
      .when(resting > 0, (el) => el.child(div().px(10).pt(4).text_size(11.5).text_color(t.dim)
        .child(`${resting} more Herdr ${resting === 1 ? "chat" : "chats"} stopped while idle; ${resting === 1 ? "it starts" : "they start"} again with the next message`)))] };
  }

  topTable(m, s, home, t) {
    return v_flex().gap(1)
      .child(h_flex().gap(12).px(10).pb(4).border_b_1().border_color(t.border)
        .child(this.cell(null, "Process", t, t.dim)).child(this.cell(70, "PID", t, t.dim))
        .child(this.cell(56, "CPU", t, t.dim)).child(this.cell(56, "Mem", t, t.dim)))
      .children(s.top.map((p) => h_flex().gap(12).px(10).py(3).items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12).truncate().text_color(t.foreground).child(this.name(s, p.pid, p.name)))
          .when(Boolean(this.context(m, s, p.pid)), (el) => el.child(div().text_size(11).truncate().text_color(t.dim).child(this.context(m, s, p.pid)))))
        .child(this.cell(70, p.pid, t, t.dim))
        .child(this.cell(56, `${p.cpu.toFixed(1)}%`, t, p.cpu > 50 ? t.working : t.muted))
        .child(this.cell(56, `${p.mem.toFixed(1)}%`, t, t.muted))));
  }

  card(m, t) {
    const k = this.key(m);
    const s = this.stats[k];
    const err = this.errors[k];
    const offline = m.layout === "unavailable";
    const dot = offline || err ? t.blocked : s ? t.done : t.dim;
    const home = s?.ports.find((p) => p.cwd && /^\/(Users|home)\/[^/]+/.test(p.cwd))?.cwd.split("/").slice(0, 3).join("/");

    const header = h_flex().gap(10).items_center()
      .child(svg(m.name ? "mods/machines/server.svg" : "mods/machines/monitor.svg").size(18).text_color(t.muted))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(16).font_semibold().text_color(t.foreground).child(m.name ?? "This computer"))
          .child(div().size(7).rounded(4).bg(dot)))
        .child(div().text_size(12).text_color(t.dim).truncate()
          .child(offline ? "offline" : s ? `${s.host} · ${s.os} · up ${ago(Date.now() / 1000 - s.boot)}` : err ? `unreachable: ${err}` : "reading…")));

    const agentsPart = s ? (this.sessions[k]?.length ? this.sessionsSection(m, s, this.sessions[k], home, t) : null) ?? this.agentsSection(m, s, home, t) : null;
    const body = !s ? [] : [
      h_flex().flex_wrap().gap(10)
        .child(this.gauge("CPU", s.cpu, `${Math.round(s.cpu)}%`, `${s.cores} cores · load ${s.load}`, t))
        .child(this.gauge("Memory", (100 * s.memUsed) / s.memTotal, bytes(s.memUsed), `of ${bytes(s.memTotal)}`, t))
        .when(s.swapTotal > 0, (el) => el.child(this.gauge("Swap", (100 * s.swapUsed) / s.swapTotal, bytes(s.swapUsed), `of ${bytes(s.swapTotal)}`, t)))
        .child(this.gauge("Disk", (100 * s.diskUsed) / s.diskTotal, bytes(s.diskUsed), `of ${bytes(s.diskTotal)}`, t)),
      ...this.section(`${k}:top`, "Top processes", null, [this.topTable(m, s, home, t)], t),
      ...(agentsPart ? this.section(`${k}:agents`, "Claude sessions", agentsPart.extra, agentsPart.content, t) : []),
      ...this.section(`${k}:ports`, "Listening ports", `${s.ports.length} · click to open`, [this.portsTable(m, s, home, t)], t),
    ];
    const open = !this.folded.has(k);

    return v_flex().flex_1().min_w(520).gap(12).p(18).rounded(12).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().id(`fold-${k}`).gap(10).items_center().cursor_pointer().on_click((_e, cx) => this.fold(k, cx))
        .child(div().flex_1().min_w(0).child(header))
        .child(this.swatches(k, t))
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(14).text_color(t.dim)))
      .when(open, (el) => el.children(body));
  }

  render(cx) {
    const visible = shown();
    if (visible && !this.wasShown && !checking()) this.poll(cx);
    this.wasShown = visible;
    const t = theme();
    const list = machines().filter((m) => !m.temporary);
    return v_flex().size_full().min_h(0).bg(t.canvas)
      .child(h_flex().h(42).flex_none().px(20).gap(10).items_center().bg(t.chrome).border_b_1().border_color(t.border)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Machines"))
        .child(div().text_size(12).text_color(t.dim).child(`${list.length} connected · every ${EVERY_MS / 1000}s`)))
      .child(div().id("machines-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().flex_wrap().items_start().gap(16).p(16)
          .children(list.map((m) => this.card(m, t)))));
  }
}
