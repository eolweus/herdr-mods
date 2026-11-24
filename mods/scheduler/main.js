import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { checking, closeOverlay, exec, hc, layout, machines, notify, openOverlay, props, run, settings, setShared, shared, theme } from "herdr";
import { ACTIONS, DETAIL, LIST, assignGroups, parseDetail, parseJobs, parseLaunchd, systemdCalendar } from "./jobs.js";
import { ClaudeEditor, openEditor, readPrompt, removeRun } from "./claude.js";

const EVERY_MS = 30000;
const ACTIONS_W = 460;
const LINE = 18;

const PRESETS = {
  systemd: ["*:0/15", "*:0/30", "hourly", "*-*-* 09:00", "Mon..Fri 09:00", "Sun 18:00"],
  launchd: ["every 30m", "every 1h", "daily 09:00", "Mon-Fri 09:00"],
  cron: ["*/30 * * * *", "0 * * * *", "0 9 * * *", "0 9 * * 1-5"],
};
const HINTS = {
  systemd: "systemd calendar: Mon..Fri 09:15, *:0/30 (every 30 min), daily, *-*-01 08:00. \"every 30m\" works too.",
  launchd: "every 30m / every 2h, daily 09:15, Mon-Fri 09:15, Sat,Sun 10:00.",
  cron: "Five cron fields: minute hour day month weekday.",
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

const shown = () => find(layout(), "work-stack")?.active === "scheduler-view";

const sh = (script, args, on) => exec("sh", ["-c", script, "sh", ...args], { on, timeout: 30000 });

function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 10 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}
const until = (at) => (at ? (at - Date.now() < 60000 ? "now" : `in ${span(at - Date.now())}`) : "");
const since = (at) => (!at ? "never" : Date.now() - at < 60000 ? "just now" : `${span(Date.now() - at)} ago`);

// "Mon..Fri *-*-* 09:15:00 Europe/Oslo" -> "Mon..Fri 09:15"
const pretty = (s) => s.replace(/\*-\*-\* /g, "").replace(/(\d{2}:\d{2}):00\b/g, "$1").replace(/ [A-Z][a-z]+\/[A-Za-z_]+/g, "").trim();

// The action's positional arguments for each kind.
function args(job, action, extra) {
  if (job.kind === "systemd") return action === "schedule" || action === "group" ? [job.unit, extra] : [job.unit, job.service];
  if (job.kind === "launchd") {
    if (action === "group") return [job.name, job.path, extra];
    return action === "schedule" ? [job.name, job.path, extra.key, JSON.stringify(extra.value)] : [job.name, job.path];
  }
  return action === "schedule" || action === "group" ? [job.line, extra] : [job.line, job.command];
}

const OTHER = "Other";
const machineKey = (machine) => machine ?? "local";
const machineLabel = (machine) => machine ?? "This computer";
export const machineColor = (machine) => (shared("machine.colors") ?? {})[machine ?? "local"] ?? null;

// A small machine label in the machine's own color, if it has one.
export function machineChip(machine, t) {
  const c = machineColor(machine);
  return div().flex_none().px(5).rounded(4).border_1().text_size(10)
    .bg(c ? `${c}1f` : t.raised).border_color(c ? `${c}66` : t.border).text_color(c ?? t.muted)
    .child(machineLabel(machine));
}
const failing = (jobs) => jobs.filter((j) => j.failed && !j.paused).length;
const KINDS = [["claude", "Claude runs"], ["calls", "Calls claude"], ["other", "Other jobs"]];
const kindOf = (j) => (j.claude ? "claude" : j.runsClaude ? "calls" : "other");

// Filters live in shared "scheduler.filters"; anything not switched off shows.
function filters() {
  const f = shared("scheduler.filters") ?? {};
  return { kinds: { claude: true, calls: true, other: true, ...f.kinds }, paused: f.paused ?? true, machines: f.machines ?? {} };
}
const shows = (j, f) => f.kinds[kindOf(j)] && (f.paused || !j.paused) && f.machines[machineKey(j.machine)] !== false;
const tildeOf = (path, h) => (h && path?.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "");
const stamp = (s) => { const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/.exec(s ?? ""); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
function took(ms) {
  const s = Math.round((ms ?? 0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Groups by name, ungrouped last; inside a group, the jobs' own order.
function byGroup(jobs) {
  const map = new Map();
  for (const j of jobs) {
    const k = j.group || OTHER;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(j);
  }
  return [...map.entries()].sort(([a], [b]) => (a === OTHER) - (b === OTHER) || a.localeCompare(b));
}

async function act(job, action, extra) {
  const r = await sh(ACTIONS[job.kind][action], args(job, action, extra), job.machine);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `${action} failed (${r.code})`);
}

export default class Scheduler extends View {
  init(_props, cx) {
    const field = props()?.field;
    if (field === "claude") { this.handle = cx.focus_handle(); return void (this.claudeEditor = new ClaudeEditor(props(), cx)); }
    this.edit = props()?.edit ?? null;
    if (this.edit) return field === "group" ? this.initGroupEditor(cx) : this.initEditor(cx);
    this.jobs = {};
    this.errors = {};
    this.armed = null;
    this.pending = new Set();
    this.seen = shared("scheduler.changed") ?? 0;
    this.bulk = new Set();
    this.opened = new Set();
    this.details = new Map();
    if (checking()) return;
    this.refresh(cx, true);
    cx.timer.every(EVERY_MS, (cx) => this.refresh(cx));
    // Relative times ("in 3h") drift; redraw once a minute.
    cx.timer.every(60000, (cx) => cx.notify());
  }

  refresh(cx, force = false) {
    if (!force && !shown()) return;
    for (const m of machines().filter((m) => !m.temporary && m.layout !== "unavailable")) {
      const k = machineKey(m.name);
      cx.spawn(async (cx) => {
        try {
          const r = await sh(LIST, [], m.name);
          this.jobs[k] = parseJobs(r.stdout, m.name);
          assignGroups(Object.values(this.jobs).flat());
          for (const j of this.jobs[k]) if (this.opened.has(j.id)) this.loadDetail(j, cx);
          delete this.errors[k];
        } catch (e) {
          this.errors[k] = String(e?.message ?? e);
        }
        cx.notify();
      });
    }
  }

  do(job, action, cx) {
    this.pending.add(job.id);
    this.armed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await act(job, action);
        if (action === "run") notify({ title: `Started ${job.name}`, level: "info", timeout: 3000 });
      } catch (e) {
        notify({ title: `${job.name}: ${action} failed`, body: String(e?.message ?? e), level: "error" });
      }
      this.pending.delete(job.id);
      this.refresh(cx, true);
    });
  }

  logs(job, cx) {
    const cmd = job.kind === "systemd"
      ? `journalctl --user -u '${job.service}' -n 500 --no-pager | less -R +G`
      : job.logs ? `less -R +G '${job.logs}'` : null;
    if (!cmd) return notify({ title: `${job.name} has no log file`, level: "info", timeout: 3000 });
    cx.spawn(async () => {
      const r = await hc(["run", "--bg", "--json", "--no-parent", ...(job.machine ? ["--on", job.machine] : []), "--", "sh", "-c", cmd]);
      try { run("terminal.peek", { terminal: JSON.parse(r.stdout).address }); }
      catch { notify({ title: "Couldn't open the logs", body: r.stderr, level: "error" }); }
    });
  }

  editSchedule(job) {
    openOverlay({ mod: "scheduler", kind: "dialog", width: 480, props: { edit: job } });
  }

  editGroup(job) {
    const groups = [...new Set(Object.values(this.jobs).flat().map((j) => j.group).filter(Boolean))].sort();
    openOverlay({ mod: "scheduler", kind: "dialog", width: 440, props: { edit: job, field: "group", groups } });
  }

  // Pause or resume every job in a group that isn't already there, one after another.
  doAll(key, jobs, action, cx) {
    const todo = jobs.filter((j) => (action === "pause" ? !j.paused : j.paused));
    if (!todo.length) return;
    this.bulk.add(key);
    for (const j of todo) this.pending.add(j.id);
    cx.notify();
    cx.spawn(async (cx) => {
      const failed = [];
      for (const j of todo) {
        try { await act(j, action); } catch (e) { failed.push(`${j.name}: ${e?.message ?? e}`); }
        this.pending.delete(j.id);
      }
      if (failed.length) notify({ title: `${action} failed for ${failed.length}`, body: failed.join("\n"), level: "error" });
      this.bulk.delete(key);
      this.refresh(cx, true);
    });
  }

  collapsed() {
    return new Set(shared("scheduler.collapsed") ?? []);
  }

  toggle(key) {
    const c = this.collapsed();
    c.has(key) ? c.delete(key) : c.add(key);
    setShared("scheduler.collapsed", [...c]);
  }

  button(id, icon, label, action, t, danger) {
    return h_flex().id(id).h(24).px(7).gap(5).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(danger ? t.blocked : t.border).bg(t.raised)
      .text_size(11).text_color(danger ? t.blocked : t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .when(Boolean(icon), (el) => el.child(svg(`mods/scheduler/${icon}.svg`).size(11)))
      .child(label);
  }

  cell(width, child, t, color) {
    const el = div().text_size(12).truncate().text_color(color ?? t.foreground).child(child);
    return width ? el.w(width).flex_none() : el.flex_1().min_w(0);
  }

  // What a run of ours did last, short enough for the status column.
  claudeState(job) {
    const c = job.claude;
    if (job.paused) return "paused";
    if (job.running) return "running";
    if (c.last) return `${c.last.is_error ? "failed" : "ok"}${c.last.total_cost_usd != null ? ` · $${c.last.total_cost_usd.toFixed(2)}` : ""}`;
    return c.ranAt ? `exit ${c.exit}` : "not run yet";
  }

  row(job, t, showMachine) {
    const c = job.claude;
    const busy = this.pending.has(job.id);
    const armed = this.armed === job.id;
    const deleting = this.armed === `del:${job.id}`;
    const failed = c ? !job.running && (c.last?.is_error || (c.exit && c.exit !== "0") || job.failed) : job.failed;
    const color = job.paused ? t.dim : failed ? t.blocked : job.running ? t.working : t.done;
    const state = c ? this.claudeState(job) : job.paused ? "paused" : job.running ? "running" : job.failed ? `failed${job.exit ? ` (${job.exit})` : ""}` : "ok";
    const last = c ? stamp(c.ranAt) : job.last;
    const open = this.opened.has(job.id);
    const badge = kindOf(job) !== "other" && div().flex_none().px(5).rounded(4).text_size(10)
      .bg(c ? t.accent : t.raised).text_color(c ? t.accent_foreground : t.accent).border_1().border_color(t.accent).child("claude");
    const line = h_flex().id(`job-${job.id}`).gap(12).px(12).py(7).items_center().rounded(7).cursor_pointer()
      .when(open, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggleDetail(job, cx))
      .child(div().w(10).flex_none().flex().justify_center().child(busy || job.running
        ? svg("mods/scheduler/spinner.svg").size(10).text_color(t.working).spin(900)
        : div().size(7).rounded(4).bg(color)))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center().min_w(0)
          .when(Boolean(showMachine), (el) => el.child(machineChip(job.machine, t)))
          .child(div().text_size(12.5).font_medium().truncate().text_color(job.paused ? t.muted : t.foreground).child(c ? c.name : job.name))
          .when(Boolean(badge), (el) => el.child(badge)))
        .child(div().text_size(11).truncate().text_color(t.dim).child(c ? `${tildeOf(c.folder, job.home)} · ${c.prompt ?? ""}` : job.about ?? "")))
      .child(this.cell(190, `${pretty(job.schedule)}${job.overridden ? " ·  changed" : ""}`, t, job.overridden ? t.accent : t.muted))
      .child(this.cell(90, job.paused ? "–" : until(job.next) || "–", t, t.muted))
      .child(this.cell(90, last != null ? since(last) : "–", t, t.dim))
      .child(this.cell(90, state, t, failed && !job.paused ? t.blocked : t.dim))
      .child(h_flex().w(ACTIONS_W).flex_none().gap(5).justify_end()
        .child(armed
          ? this.button(`run-${job.id}`, "play", "Run it now?", (cx) => this.do(job, "run", cx), t, true)
          : this.button(`run-${job.id}`, "play", "Run", (cx) => { this.armed = job.id; cx.notify(); }, t))
        .child(job.paused
          ? this.button(`res-${job.id}`, "play", "Resume", (cx) => this.do(job, "resume", cx), t)
          : this.button(`pau-${job.id}`, "pause", "Pause", (cx) => this.do(job, "pause", cx), t))
        .child(c
          ? this.button(`edit-${job.id}`, "pencil", "Edit", () => openEditor(job, this.slugs()), t)
          : this.button(`edit-${job.id}`, "pencil", "Schedule", () => this.editSchedule(job), t))
        .child(this.button(`grp-${job.id}`, "tag", "Group", () => this.editGroup(job), t))
        .when(Boolean(c?.last?.session_id), (el) => el.child(this.button(`chat-${job.id}`, "chat", "Open chat", () => this.openChat(job), t)))
        .when(!c && job.kind !== "cron", (el) => el.child(this.button(`log-${job.id}`, "logs", "Logs", (cx) => this.logs(job, cx), t)))
        .when(Boolean(job.overridden) && !c, (el) => el.child(this.button(`rst-${job.id}`, "reset", "Original", (cx) => this.do(job, "reset", cx), t)))
        .when(Boolean(c), (el) => el.child(deleting
          ? this.button(`del-${job.id}`, "x", "Delete it?", (cx) => this.deleteRun(job, cx), t, true)
          : this.button(`del-${job.id}`, "x", "Delete", (cx) => { this.armed = `del:${job.id}`; cx.notify(); }, t))));
    return open ? v_flex().child(line).child(div().pl(34).pr(12).pb(8).child(this.detail(job, t))) : line;
  }

  toggleDetail(job, cx) {
    if (this.opened.has(job.id)) this.opened.delete(job.id);
    else { this.opened.add(job.id); this.loadDetail(job, cx); }
    cx.notify();
  }

  loadDetail(job, cx) {
    this.details.set(job.id, { loading: true, sections: this.details.get(job.id)?.sections ?? null });
    const target = job.kind === "systemd" ? [job.unit, job.service] : job.kind === "launchd" ? [job.path, job.logs ?? ""] : [job.command, ""];
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", DETAIL, "sh", job.kind, ...target], { on: job.machine, timeout: 20000 });
        const sections = parseDetail(r.stdout);
        const c = job.claude;
        if (c) {
          const prompt = await readPrompt(job).catch(() => c.prompt ?? "");
          sections.push({ kind: "prompt", title: `in ${tildeOf(c.folder, job.home)}`, lines: prompt.split("\n"), wrap: true });
          if (c.last) sections.push({
            kind: "result", wrap: true, lines: (c.last.result || "(no text)").split("\n"),
            title: `${c.last.is_error ? "failed" : "done"} ${since(stamp(c.ranAt))} · ${took(c.last.duration_ms)} · ${c.last.num_turns ?? 0} turn${c.last.num_turns === 1 ? "" : "s"}`,
          });
        }
        this.details.set(job.id, { sections });
      } catch (e) {
        this.details.set(job.id, { error: String(e?.message ?? e) });
      }
      cx.notify();
    });
  }

  // The unit, the script it runs (claude lines marked) and its recent log.
  detail(job, t) {
    const d = this.details.get(job.id);
    const mono = settings().font_family;
    const box = () => v_flex().rounded(8).border_1().border_color(t.border).bg(t.background).overflow_hidden();
    if (!d || (d.loading && !d.sections)) return box().p(10).child(div().text_size(12).text_color(t.dim).child("Reading…"));
    if (d.error) return box().p(10).child(div().text_size(12).text_color(t.blocked).child(d.error));
    const NAMES = { prompt: "Prompt", result: "Last result", command: "Command", unit: "Unit", script: "Script", log: "Recent log" };
    const order = { prompt: 0, result: 1, command: 2, script: 3, unit: 4, log: 5 };
    const sections = [...d.sections].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
    return v_flex().gap(8).children(sections.map((sec, i) => {
      const lines = sec.lines.slice(0, 400);
      const claudeLine = (l) => sec.kind === "script" && /(^|[^#\w./-])claude\s+(-p|--print)/.test(l) && !/^\s*#/.test(l);
      return box()
        .child(h_flex().px(10).py(5).gap(8).items_center().border_b_1().border_color(t.border).bg(t.surface)
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(NAMES[sec.kind] ?? sec.kind))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(sec.title ?? ""))
          .when(sec.kind === "script" && lines.some(claudeLine), (el) => el.child(div().text_size(11).text_color(t.accent).child("runs claude -p"))))
        // A scroll area needs a definite height; lines don't wrap, so it's lines × LINE, capped.
        .when(Boolean(sec.wrap), (el) => el.child(div().h(Math.min(260, lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 130)), 0) * LINE + 16)).flex_none()
          .child(v_flex().id(`detail-${job.id}-${i}`).size_full().px(10).py(8).overflow_y_scrollbar()
            .child(div().text_size(12.5).text_color(t.foreground).child(lines.join("\n"))))))
        .when(!sec.wrap, (el) => el.child(div().h(Math.min(sec.kind === "log" ? 240 : 360, lines.length * LINE + 12)).flex_none()
          .child(v_flex().id(`detail-${job.id}-${i}`).size_full().py(6).overflow_scrollbar()
            .children(lines.map((l) => div().h(LINE).flex_none().px(10).whitespace_nowrap().font_family(mono).text_size(11.5)
              .when(claudeLine(l), (el) => el.bg(t.selected).text_color(t.foreground))
              .when(!claudeLine(l), (el) => el.text_color(sec.kind === "log" ? t.muted : t.foreground))
              .child(l.replace(/\t/g, "    ") || " "))))));
    }));
  }

  primary(id, label, action, t) {
    return h_flex().id(id).h(24).px(9).items_center().rounded(6).cursor_pointer()
      .bg(t.solid).text_color(t.solid_foreground).text_size(11.5).font_medium()
      .hover((s) => s.opacity(0.88)).on_click(() => action()).child(label);
  }

  slugs() {
    const out = {};
    for (const [k, js] of Object.entries(this.jobs)) out[k] = js.filter((j) => j.claude).map((j) => j.claude.slug);
    return out;
  }

  deleteRun(job, cx) {
    this.armed = null;
    this.pending.add(job.id);
    cx.notify();
    cx.spawn(async (cx) => {
      try { await removeRun(job); } catch (e) { notify({ title: `Couldn't delete ${job.claude.name}`, body: String(e?.message ?? e), level: "error" }); }
      this.pending.delete(job.id);
      this.refresh(cx, true);
    });
  }

  // The run's session, resumed in a new chat tab.
  openChat(job) {
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    run("tab.new", { mod: "herdr-chat", props: { key, machine: job.machine, cwd: job.claude.folder, resume: job.claude.last.session_id } });
  }

  header(t) {
    return h_flex().gap(12).px(12).pb(5).border_b_1().border_color(t.border)
      .child(div().w(10).flex_none())
      .child(this.cell(null, "Job", t, t.dim)).child(this.cell(190, "Schedule", t, t.dim))
      .child(this.cell(90, "Next", t, t.dim)).child(this.cell(90, "Last", t, t.dim))
      .child(this.cell(90, "Status", t, t.dim)).child(div().w(ACTIONS_W).flex_none());
  }

  card(icon, title, sub, bad, t, color) {
    return v_flex().gap(2).p(14).rounded(12).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().gap(10).items_center().pb(8)
        .child(svg(`mods/scheduler/${icon}.svg`).size(16).text_color(color ?? t.muted))
        .child(div().text_size(15).font_semibold().text_color(color ?? t.foreground).child(title))
        .child(div().text_size(12).text_color(t.dim).child(sub))
        .when(bad > 0, (el) => el.child(div().text_size(12).text_color(t.blocked).child(`${bad} failing`))));
  }

  // A group's heading inside a card: fold, name, count, and pause/resume for all of it.
  section(key, name, all, t, showMachine, f) {
    const jobs = all.filter((j) => shows(j, f));
    const hidden = all.length - jobs.length;
    const open = !this.collapsed().has(key);
    const bad = failing(jobs);
    const paused = jobs.filter((j) => j.paused).length;
    const busy = this.bulk.has(key);
    const head = h_flex().id(`grp-${key}`).gap(8).px(8).pt(8).pb(4).items_center().rounded(6).cursor_pointer()
      .on_click((_e, cx) => { this.toggle(key); cx.notify(); })
      .child(svg(`mods/scheduler/${open ? "chevron" : "chevron-right"}.svg`).size(12).text_color(t.dim))
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(name))
      .child(div().text_size(11.5).text_color(t.dim).child(`${jobs.length} job${jobs.length === 1 ? "" : "s"}${paused ? ` · ${paused} paused` : ""}`))
      .when(hidden > 0, (el) => el.child(this.hiddenNote(hidden, t)))
      .when(bad > 0, (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(`${bad} failing`)))
      .child(div().flex_1())
      .when(busy, (el) => el.child(svg("mods/scheduler/spinner.svg").size(10).text_color(t.working).spin(900)))
      .when(name !== OTHER && jobs.length > 0 && paused < jobs.length, (el) => el.child(this.button(`pall-${key}`, "pause", "Pause all", (cx) => this.doAll(key, jobs, "pause", cx), t)))
      .when(name !== OTHER && paused > 0, (el) => el.child(this.button(`rall-${key}`, "play", "Resume all", (cx) => this.doAll(key, jobs, "resume", cx), t)));
    return [head, ...(open ? jobs.map((j) => this.row(j, t, showMachine)) : [])];
  }

  hiddenNote(n, t) {
    return div().text_size(11.5).text_color(t.dim).italic().child(`${n} hidden by filters`);
  }

  // A machine's card, its jobs under their groups; a lone ungrouped list needs no heading.
  machineCard(m, t, f) {
    const k = machineKey(m.name);
    const all = this.jobs[k];
    const err = this.errors[k];
    const jobs = all?.filter((j) => shows(j, f));
    const hidden = (all?.length ?? 0) - (jobs?.length ?? 0);
    const note = (text, color) => [div().px(12).py(6).text_size(12).text_color(color ?? t.dim).child(text)];
    const groups = all ? byGroup(all) : [];
    const body = m.layout === "unavailable" ? note("Offline")
      : err ? note(err, t.blocked)
      : !all ? note("Reading…")
      : !all.length ? note("Nothing scheduled")
      : !jobs.length ? []
      : groups.length === 1 && groups[0][0] === OTHER ? jobs.map((j) => this.row(j, t))
      : groups.flatMap(([g, js]) => this.section(`${k}:${g}`, g, js, t, false, f));
    return this.card(m.name ? "server" : "monitor", machineLabel(m.name), all ? `${jobs.length} job${jobs.length === 1 ? "" : "s"}` : "", failing(jobs ?? []), t, machineColor(m.name))
      .when(hidden > 0, (el) => el.child(div().pl(26).mt(-8).pb(6).child(this.hiddenNote(hidden, t))))
      .when(body.length > 0, (el) => el.child(this.header(t)).children(body));
  }

  // One card per group, its jobs from every machine.
  groupCards(list, t, f) {
    const all = list.flatMap((m) => this.jobs[machineKey(m.name)] ?? []);
    const waiting = list.filter((m) => m.layout !== "unavailable" && !this.jobs[machineKey(m.name)] && !this.errors[machineKey(m.name)]);
    const problems = list.filter((m) => m.layout === "unavailable" || this.errors[machineKey(m.name)])
      .map((m) => `${machineLabel(m.name)}: ${m.layout === "unavailable" ? "offline" : this.errors[machineKey(m.name)]}`);
    const cards = byGroup(all).map(([g, everything]) => {
      const js = everything.filter((j) => shows(j, f));
      const hidden = everything.length - js.length;
      const where = [...new Set(everything.map((j) => j.machine))];
      const key = `group:${g}`;
      const open = !this.collapsed().has(key) && js.length > 0;
      const bad = failing(js);
      const paused = js.filter((j) => j.paused).length;
      return v_flex().gap(2).p(14).rounded(12).bg(t.surface).border_1().border_color(t.border)
        .child(h_flex().id(key).gap(10).items_center().pb(open ? 8 : 0).cursor_pointer()
          .on_click((_e, cx) => { this.toggle(key); cx.notify(); })
          .child(svg(`mods/scheduler/${open ? "chevron" : "chevron-right"}.svg`).size(14).text_color(t.muted))
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child(g))
          .child(h_flex().text_size(12).text_color(t.dim)
            .child(`${js.length} job${js.length === 1 ? "" : "s"} · `)
            .children(where.flatMap((m, i) => [...(i ? [div().child(", ")] : []), div().text_color(machineColor(m) ?? t.dim).child(machineLabel(m))]))
            .when(paused > 0, (el) => el.child(` · ${paused} paused`)))
          .when(hidden > 0, (el) => el.child(this.hiddenNote(hidden, t)))
          .when(bad > 0, (el) => el.child(div().text_size(12).text_color(t.blocked).child(`${bad} failing`)))
          .child(div().flex_1())
          .when(this.bulk.has(key), (el) => el.child(svg("mods/scheduler/spinner.svg").size(10).text_color(t.working).spin(900)))
          .when(g !== OTHER && js.length > 0 && paused < js.length, (el) => el.child(this.button(`pall-${key}`, "pause", "Pause all", (cx) => this.doAll(key, js, "pause", cx), t)))
          .when(g !== OTHER && paused > 0, (el) => el.child(this.button(`rall-${key}`, "play", "Resume all", (cx) => this.doAll(key, js, "resume", cx), t))))
        .when(open, (el) => el.child(this.header(t)).children(js.map((j) => this.row(j, t, true))));
    });
    const notes = [...waiting.map((m) => `${machineLabel(m.name)}: reading…`), ...problems];
    return [...cards, ...(notes.length ? [div().px(4).text_size(12).text_color(t.dim).child(notes.join(" · "))] : [])];
  }

  checkbox(id, label, on, action, t, color) {
    return h_flex().id(id).gap(6).px(6).py(3).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { action(); cx.notify(); })
      .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border_1()
        .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
        .when(on, (el) => el.child(svg("mods/scheduler/check.svg").size(10).text_color(t.accent_foreground))))
      .child(div().text_size(12).text_color(color ?? (on ? t.foreground : t.muted)).child(label));
  }

  setFilter(change) {
    const f = filters();
    setShared("scheduler.filters", change(f) ?? f);
  }

  filterBar(list, f, t) {
    const all = Object.values(this.jobs).flat();
    const count = (pred) => all.filter(pred).length;
    const sep = () => div().w(1).h(16).mx(6).bg(t.border);
    return h_flex().h(36).flex_none().px(18).gap(2).items_center().bg(t.chrome).border_b_1().border_color(t.border)
      .child(div().pr(6).text_size(11.5).text_color(t.dim).child("Show"))
      .children(KINDS.map(([k, label]) => this.checkbox(`f-${k}`, `${label} ${count((j) => kindOf(j) === k)}`, f.kinds[k],
        () => this.setFilter((x) => { x.kinds[k] = !x.kinds[k]; }), t)))
      .child(sep())
      .child(this.checkbox("f-paused", `Paused ${count((j) => j.paused)}`, f.paused, () => this.setFilter((x) => { x.paused = !x.paused; }), t))
      .child(sep())
      .children(list.map((m) => {
        const k = machineKey(m.name);
        return this.checkbox(`f-m-${k}`, machineLabel(m.name), f.machines[k] !== false,
          () => this.setFilter((x) => { x.machines[k] = x.machines[k] === false; }), t, machineColor(m.name));
      }));
  }

  segmented(by, t) {
    const seg = (value, label) => div().id(`by-${value}`).px(10).h(24).flex().items_center().rounded(5).cursor_pointer()
      .text_size(11.5).text_color(by === value ? t.foreground : t.muted).when(by === value, (el) => el.bg(t.raised))
      .on_click((_e, cx) => { setShared("scheduler.by", value); cx.notify(); })
      .child(label);
    return h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border).bg(t.background)
      .child(seg("machine", "By machine")).child(seg("group", "By group"));
  }

  // The dialog: one job's new schedule.
  initEditor(cx) {
    const job = this.edit;
    this.value = job.editable ?? "";
    this.error = null;
    this.preview = null;
    this.saving = false;
    this.input = InputState.new({ value: this.value });
    this.input.set_selected_range({ start: 0, end: this.value.length });
    this.input.on("change", (_e, cx) => { this.value = this.input.value(); this.check(cx); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.save(cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.check(cx);
  }

  // What the typed schedule means, before saving: systemd asks the machine itself.
  check(cx) {
    const job = this.edit;
    const v = this.value.trim().replace(/[\r\n]/g, "");
    this.error = null;
    if (job.kind === "launchd") {
      const p = parseLaunchd(v);
      this.preview = p ? (p.key === "StartInterval" ? `Every ${p.value} seconds` : `At ${JSON.stringify(p.value)}`) : null;
      if (!p && v) this.error = "Not understood.";
      return;
    }
    if (job.kind === "cron") {
      const ok = /^(@\w+|(\S+\s+){4}\S+)$/.test(v);
      this.preview = ok ? `${v}  ${job.command}` : null;
      if (!ok && v) this.error = "Needs five fields.";
      return;
    }
    const nonce = (this.nonce ?? 0) + 1;
    this.nonce = nonce;
    cx.timer.after(350, (cx) => {
      if (nonce !== this.nonce) return;
      cx.spawn(async (cx) => {
        const r = await sh(`systemd-analyze calendar "$1" 2>&1 | sed -n 's/^ *\\(Normalized form\\|Next elapse\\): //p'`, [systemdCalendar(v)], job.machine).catch(() => null);
        if (nonce !== this.nonce) return;
        const lines = r?.stdout.trim().split("\n").filter(Boolean) ?? [];
        this.preview = lines.length === 2 ? `${lines[0]}\nnext ${lines[1]}` : null;
        this.error = lines.length === 2 || !v ? null : "systemd doesn't understand this.";
        cx.notify();
      });
    });
  }

  save(cx) {
    const job = this.edit;
    const v = this.value.trim().replace(/[\r\n]/g, "");
    if (!v || this.saving) return;
    let extra = v;
    if (job.kind === "systemd") extra = systemdCalendar(v);
    if (job.kind === "launchd") extra = parseLaunchd(v);
    if (job.kind === "cron") extra = `${v} ${job.command}`;
    if (!extra) { this.error = "Not understood."; return cx.notify(); }
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await act(job, "schedule", extra);
        setShared("scheduler.changed", Date.now());
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.saving = false;
        cx.notify();
      }
    });
  }

  renderEditor() {
    const t = theme();
    const job = this.edit;
    const chip = (p) => div().id(`preset-${p}`).px(8).py(3).rounded(6).border_1().border_color(t.border).bg(t.raised)
      .text_size(11.5).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.input.set_value(p); this.value = p; this.check(cx); cx.notify(); })
      .child(p);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("sched-edit").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().p(18).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(15).font_semibold().truncate().child(`Schedule · ${job.name}`))
          .child(div().text_size(11.5).text_color(t.dim).child(`${job.machine ?? "This computer"} · ${job.kind} · now ${pretty(job.schedule)}`)))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.error ? t.blocked : t.accent)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().flex_wrap().gap(5).children(PRESETS[job.kind].map(chip)))
      .child(div().text_size(11.5).text_color(t.dim).child(HINTS[job.kind]))
      .when(Boolean(this.preview) && !this.error, (el) => el.child(div().text_size(11.5).text_color(t.muted).child(this.preview)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.error)))
      .when(job.kind === "systemd", (el) => el.child(div().text_size(10.5).text_color(t.dim)
        .child("Saved as a drop-in (…/<timer>.d/50-herdr-schedule.conf); the unit file stays as it is.")))
      .child(h_flex().pt(6).gap(8).justify_end()
        .child(button("se-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("se-save", this.saving ? "Saving…" : "Save", true, (_e, cx) => this.save(cx))));
  }

  initGroupEditor(cx) {
    const job = this.edit;
    this.value = job.tag ?? job.group ?? "";
    this.error = null;
    this.saving = false;
    this.input = InputState.new({ value: this.value, placeholder: "No group" });
    this.input.set_selected_range({ start: 0, end: this.value.length });
    this.input.on("change", (_e, cx) => { this.value = this.input.value(); this.error = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.saveGroup(cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  saveGroup(cx, value = this.value) {
    const v = value.trim();
    if (this.saving) return;
    if (v && !/^[\w.@ -]+$/.test(v)) { this.error = "Letters, digits, spaces and . - _ @ only."; return cx.notify(); }
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await act(this.edit, "group", v);
        setShared("scheduler.changed", Date.now());
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.saving = false;
        cx.notify();
      }
    });
  }

  renderGroupEditor() {
    const t = theme();
    const job = this.edit;
    const groups = (props()?.groups ?? []).filter((g) => g !== job.group);
    const chip = (g) => div().id(`g-${g}`).px(8).py(3).rounded(6).border_1().border_color(t.border).bg(t.raised)
      .text_size(11.5).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.input.set_value(g); this.value = g; cx.notify(); })
      .child(g);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const where = { systemd: "an X-Group= drop-in (…/<timer>.d/40-herdr-group.conf)", launchd: "a HerdrGroup key in the plist", cron: "a \"# herdr-group:\" line above it" }[job.kind];
    const now = job.tag ? `tagged ${job.tag}` : job.group ? `${job.group}, guessed from its name` : "no group";
    return v_flex().id("grp-edit").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().p(18).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(15).font_semibold().truncate().child(`Group · ${job.name}`))
          .child(div().text_size(11.5).text_color(t.dim).child(`${machineLabel(job.machine)} · ${job.kind} · ${now}`)))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.error ? t.blocked : t.accent)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .when(groups.length > 0, (el) => el.child(h_flex().flex_wrap().gap(5).children(groups.map(chip))))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.error)))
      .child(div().text_size(10.5).text_color(t.dim).child(`Saved as ${where}. Empty goes back to guessing from the name.`))
      .child(h_flex().pt(6).gap(8).justify_end()
        .when(Boolean(job.tag), (el) => el.child(button("ge-clear", "Remove tag", false, (_e, cx) => this.saveGroup(cx, ""))))
        .child(button("ge-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("ge-save", this.saving ? "Saving…" : "Save", true, (_e, cx) => this.saveGroup(cx))));
  }

  render(cx) {
    if (this.claudeEditor) return this.claudeEditor.render(this.handle);
    if (this.edit) return props()?.field === "group" ? this.renderGroupEditor() : this.renderEditor();
    const visible = shown();
    const changed = shared("scheduler.changed") ?? 0;
    if ((visible && !this.wasShown) || changed !== this.seen) {
      this.seen = changed;
      if (!checking()) this.refresh(cx, true);
    }
    this.wasShown = visible;
    const t = theme();
    const list = machines().filter((m) => !m.temporary);
    const by = shared("scheduler.by") === "machine" ? "machine" : "group";
    const f = filters();
    return v_flex().size_full().min_h(0).bg(t.canvas)
      .child(h_flex().h(42).flex_none().px(20).gap(10).items_center().bg(t.chrome).border_b_1().border_color(t.border)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Scheduler"))
        .child(div().text_size(12).text_color(t.dim).child("systemd timers, launchd agents, crontab and Claude runs on every machine"))
        .child(div().flex_1())
        .child(this.segmented(by, t))
        .child(this.primary("new-run", "New Claude run", () => openEditor(null, this.slugs()), t))
        .child(this.button("refresh", "reset", "Refresh", (cx) => this.refresh(cx, true), t)))
      .child(this.filterBar(list, f, t))
      .child(div().id("scheduler-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().gap(16).p(16).children(by === "group" ? this.groupCards(list, t, f) : list.map((m) => this.machineCard(m, t, f)))));
  }
}
