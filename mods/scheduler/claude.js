// Scheduled Claude runs: `claude -p <prompt>` in a folder on a timer (systemd on Linux, launchd on macOS).
// Each run lives in ~/.config/herdr-claude/<slug>/ (job.env, prompt.md); outputs go to
// ~/.local/state/herdr-claude/<slug>/ (<time>.json per run, last.json, runs).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { closeOverlay, exec, machines, openOverlay, props, setShared, shared, theme } from "herdr";
import { parseLaunchd } from "./jobs.js";

export const UNIT = (slug) => `herdr-claude-${slug}`;
export const LABEL = (slug) => `com.herdr.claude.${slug}`;

export const MODES = [
  ["auto", "Auto", "Claude decides what's safe to run; risky actions are refused"],
  ["acceptEdits", "Accept edits", "May edit files in the folder; other tools are refused"],
  ["dontAsk", "Read only", "Only tools that need no approval"],
  ["bypassPermissions", "Bypass", "Runs anything without asking. Only for trusted prompts"],
];
const MODELS = [["", "Default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
const PRESETS = ["daily 09:00", "Mon-Fri 08:30", "every 2h", "Sun 18:00"];

const RUNNER = String.raw`#!/bin/sh
# Written by the Herdr scheduler: run.sh <slug>
s="$1"; d="$HOME/.config/herdr-claude/$s"; out="$HOME/.local/state/herdr-claude/$s"
. "$d/job.env" || exit 1
mkdir -p "$out"
export PATH="$RUN_PATH"
cd "$FOLDER" || { echo "No such folder: $FOLDER" >&2; exit 1; }
ts=$(date +%Y%m%d-%H%M%S)
if [ "$MODE" = bypassPermissions ]; then set -- --dangerously-skip-permissions; else set -- --permission-mode "$MODE"; fi
[ -n "$MODEL" ] && set -- "$@" --model "$MODEL"
"$CLAUDE" -p "$(cat "$d/prompt.md")" --output-format json "$@" > "$out/$ts.json" 2> "$out/$ts.err" < /dev/null
code=$?
[ -s "$out/$ts.err" ] || rm -f "$out/$ts.err"
cp "$out/$ts.json" "$out/last.json"
printf '%s %s\n' "$ts" "$code" >> "$out/runs"
ls -1t "$out"/2*.json 2>/dev/null | tail -n +31 | while read -r f; do rm -f "$f" "\${f%.json}.err"; done
exit $code
`.replace("\\${", "${");

// Writes the runner, job.env and prompt.md: $1 slug, $2 job.env, $3 prompt, $4 runner.
const FILES = String.raw`
set -e
c="$HOME/.config/herdr-claude"; mkdir -p "$c/$1" "$HOME/.local/state/herdr-claude/$1"
printf '%s' "$4" > "$c/run.sh"; chmod +x "$c/run.sh"
printf '%s' "$2" > "$c/$1/job.env"
printf '%s\n' "$3" > "$c/$1/prompt.md"
`;

// $5 service, $6 timer, $7 "1" to leave it paused.
const INSTALL_SYSTEMD = FILES + String.raw`
u="$HOME/.config/systemd/user"; mkdir -p "$u"
printf '%s' "$5" > "$u/herdr-claude-$1.service"
printf '%s' "$6" > "$u/herdr-claude-$1.timer"
systemctl --user daemon-reload
if [ "$7" != 1 ]; then systemctl --user enable "herdr-claude-$1.timer"; systemctl --user restart "herdr-claude-$1.timer"; fi
true`;

// $5 the plist as JSON, $7 "1" to leave it paused.
const INSTALL_LAUNCHD = FILES + String.raw`
p="$HOME/Library/LaunchAgents/com.herdr.claude.$1.plist"; l="gui/$(id -u)/com.herdr.claude.$1"
launchctl bootout "$l" 2>/dev/null || true
printf '%s' "$5" > "$p"; plutil -convert xml1 "$p"
if [ "$7" != 1 ]; then launchctl enable "$l"; launchctl bootstrap "gui/$(id -u)" "$p"; fi
true`;

const REMOVE = {
  systemd: String.raw`
systemctl --user disable --now "herdr-claude-$1.timer" 2>/dev/null
rm -f "$HOME/.config/systemd/user/herdr-claude-$1.timer" "$HOME/.config/systemd/user/herdr-claude-$1.service"
systemctl --user daemon-reload
rm -rf "$HOME/.config/herdr-claude/$1" "$HOME/.local/state/herdr-claude/$1"
true`,
  launchd: String.raw`
launchctl bootout "gui/$(id -u)/com.herdr.claude.$1" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/com.herdr.claude.$1.plist"
rm -rf "$HOME/.config/herdr-claude/$1" "$HOME/.local/state/herdr-claude/$1"
true`,
};

const q = (v) => `'${String(v ?? "").replace(/'/g, `'\\''`)}'`;
const sh = (script, args, on) => exec("sh", ["-c", script, "sh", ...args], { on, timeout: 60000 });

export const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";

// "daily 09:00", "Mon-Fri 08:30", "every 2h", or anything systemd-analyze understands.
export function toSystemd(text) {
  const s = text.trim();
  let m = /^every\s+(\d+)\s*(m|h|d)$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    return { m: `*:0/${n}`, h: `0/${n}:00`, d: n === 1 ? "daily" : `*-*-1/${n} 00:00` }[m[2].toLowerCase()];
  }
  m = /^(?:(daily|[a-z,\-]+)\s+)?(\d{1,2}:\d{2})$/i.exec(s);
  if (m) return !m[1] || m[1].toLowerCase() === "daily" ? `*-*-* ${m[2]}` : `${m[1].replace(/-/g, "..")} ${m[2]}`;
  return s;
}

async function machineEnv(on) {
  const r = await exec("sh", ["-c", `uname; "\${SHELL:-sh}" -lc 'command -v claude; printf "%s" "$PATH"' 2>/dev/null`], { on });
  const [os, claude, path] = r.stdout.split("\n");
  if (!claude?.startsWith("/")) throw new Error(`claude isn't installed on ${on ?? "this computer"} (not on the login shell's PATH)`);
  return { os, claude, path };
}

async function install(job) {
  const env = await machineEnv(job.machine);
  const jobEnv = [
    `NAME=${q(job.name)}`, `FOLDER=${q(job.folder)}`, `MODE=${q(job.mode)}`, `MODEL=${q(job.model)}`,
    `CLAUDE=${q(env.claude)}`, `RUN_PATH=${q(env.path)}`, "",
  ].join("\n");
  const paused = job.paused ? "1" : "0";
  let r;
  if (env.os === "Darwin") {
    const when = parseLaunchd(job.schedule);
    if (!when) throw new Error("launchd needs: every 30m, daily 09:00, Mon-Fri 09:00, Sat,Sun 10:00");
    const out = `\${HOME}/.local/state/herdr-claude/${job.slug}/launchd.log`;
    const home = (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: job.machine })).stdout;
    const plist = {
      Label: LABEL(job.slug), HerdrClaude: job.slug,
      ProgramArguments: ["/bin/sh", `${home}/.config/herdr-claude/run.sh`, job.slug],
      [when.key]: when.value, StandardOutPath: out.replace("${HOME}", home), StandardErrorPath: out.replace("${HOME}", home),
    };
    r = await sh(INSTALL_LAUNCHD, [job.slug, jobEnv, job.prompt, RUNNER, JSON.stringify(plist), "", paused], job.machine);
  } else {
    const cal = toSystemd(job.schedule);
    const check = await sh(`systemd-analyze calendar "$1" >/dev/null 2>&1`, [cal], job.machine);
    if (check.code !== 0) throw new Error(`systemd doesn't understand "${cal}"`);
    const service = `[Unit]\nDescription=Claude: ${job.name}\nX-Herdr-Claude=${job.slug}\n\n[Service]\nType=oneshot\nExecStart=/bin/sh %h/.config/herdr-claude/run.sh ${job.slug}\n`;
    const timer = `[Unit]\nDescription=Claude: ${job.name}\nX-Herdr-Claude=${job.slug}\n\n[Timer]\nOnCalendar=${cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;
    r = await sh(INSTALL_SYSTEMD, [job.slug, jobEnv, job.prompt, RUNNER, service, timer, paused], job.machine);
  }
  if (r.code !== 0) throw new Error(r.stderr.trim() || `install failed (${r.code})`);
}

export async function removeRun(job) {
  const r = await sh(REMOVE[job.kind], [job.claude.slug], job.machine);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `delete failed (${r.code})`);
}

// Reading a run's prompt in full (the list only carries a preview).
export async function readPrompt(job) {
  const r = await exec("sh", ["-c", 'cat "$HOME/.config/herdr-claude/$1/prompt.md"', "sh", job.claude.slug], { on: job.machine });
  return r.stdout.replace(/\n$/, "");
}

export function openEditor(job, slugs) {
  openOverlay({ mod: "scheduler", kind: "dialog", width: 600, modal: true, props: { field: "claude", edit: job ?? null, slugs } });
}

// The dialog for a new run, or for changing one (machine and slug stay).
export class ClaudeEditor {
  constructor(p, cx) {
    const job = p.edit;
    this.p = p;
    this.job = job;
    this.slugs = p.slugs ?? {};
    this.machine = job?.machine ?? null;
    this.folder = job?.claude.folder ?? null;
    this.mode = job?.claude.mode ?? "auto";
    this.model = job?.claude.model ?? "";
    this.error = null;
    this.saving = false;
    this.pickId = null;
    this.name = InputState.new({ value: job?.claude.name ?? "", placeholder: "Morning PR review" });
    this.schedule = InputState.new({ value: job?.editable ?? "daily 09:00", placeholder: "daily 09:00" });
    this.prompt = TextareaState.new({ placeholder: "What should Claude do each time?" });
    this.prompt.set_auto_grow(6, 14);
    this.name.focus();
    if (job) cx.spawn(async (cx) => {
      this.prompt.set_value(await readPrompt(job).catch(() => job.claude.prompt ?? ""));
      cx.notify();
    });
  }

  takePick() {
    const r = shared("folder-picker.result");
    if (!this.pickId || r?.id !== this.pickId) return;
    this.pickId = null;
    if (r.folder) this.folder = r.folder;
  }

  pickFolder() {
    this.pickId = `scheduler-${Date.now().toString(36)}`;
    openOverlay({ mod: "folder-picker", kind: "popup", width: 280, props: { id: this.pickId, machine: this.machine, folder: this.folder } });
  }

  save(cx) {
    if (this.saving) return;
    const name = this.name.value().trim();
    const prompt = this.prompt.value().trim();
    const schedule = this.schedule.value().trim();
    this.error = !name ? "Give it a name." : !this.folder ? "Pick a folder." : !prompt ? "Write a prompt." : !schedule ? "Set a schedule." : null;
    if (this.error) return cx.notify();
    let slug = this.job?.claude.slug;
    if (!slug) {
      const taken = new Set(this.slugs[this.machine ?? "local"] ?? []);
      const base = slugify(name);
      slug = base;
      for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
    }
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await install({ slug, name, folder: this.folder, prompt, schedule, mode: this.mode, model: this.model, machine: this.machine, paused: this.job?.paused });
        setShared("scheduler.changed", Date.now());
        closeOverlay(this.p.overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.saving = false;
        cx.notify();
      }
    });
  }

  render(handle) {
    this.takePick();
    const t = theme();
    const label = (text) => div().text_size(11.5).font_medium().text_color(t.muted).child(text);
    const chip = (id, text, on, action, color) => div().id(id).px(9).py(4).rounded(6).border_1().cursor_pointer()
      .border_color(on ? color ?? t.accent : t.border).bg(on ? (color ? `${color}1f` : t.selected) : t.raised)
      .text_size(12).text_color(color ?? (on ? t.foreground : t.muted)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { action(); cx.notify(); }).child(text);
    const mc = (m) => (shared("machine.colors") ?? {})[m ?? "local"] ?? null;
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const field = (state) => Input.new(state).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground);
    const list = machines().filter((m) => !m.temporary && m.layout !== "unavailable");
    const modeInfo = MODES.find(([k]) => k === this.mode);
    return v_flex().id("claude-edit").track_focus(handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child(this.job ? `Edit · ${this.job.claude.name}` : "New scheduled Claude run"))
      .child(v_flex().gap(5).child(label("Name")).child(field(this.name)))
      .child(h_flex().gap(14)
        .child(v_flex().gap(5).child(label("Machine")).child(h_flex().gap(5).children(this.job
          ? [chip("m-fixed", this.machine ?? "This computer", true, () => {}, mc(this.machine))]
          : list.map((m) => chip(`m-${m.name ?? "local"}`, m.name ?? "This computer", m.name === this.machine, () => {
            if (m.name !== this.machine) { this.machine = m.name; this.folder = null; }
          }, mc(m.name))))))
        .child(v_flex().flex_1().min_w(0).gap(5).child(label("Folder"))
          .child(h_flex().id("folder").h(30).px(10).gap(6).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
            .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.pickFolder())
            .child(svg("mods/folder-picker/folder.svg").size(13).text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(this.folder ? t.foreground : t.dim).child(this.folder ?? "Pick a folder…")))))
      .child(v_flex().gap(5).child(label("Prompt"))
        .child(Textarea.new(this.prompt).w_full().px(10).py(8).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13)))
      .child(v_flex().gap(5).child(label("Schedule"))
        .child(h_flex().gap(8).items_center()
          .child(div().w(200).child(field(this.schedule)))
          .child(h_flex().gap(5).flex_wrap().children(PRESETS.map((p) => chip(`s-${p}`, p, false, () => this.schedule.set_value(p))))))
        .child(div().text_size(11).text_color(t.dim).child("daily 09:00 · Mon-Fri 08:30 · Sat,Sun 10:00 · every 30m / 2h. On Linux any systemd calendar works too.")))
      .child(h_flex().gap(14)
        .child(v_flex().gap(5).child(label("Permissions")).child(h_flex().gap(5).children(MODES.map(([k, text]) => chip(`p-${k}`, text, this.mode === k, () => { this.mode = k; })))))
        .child(v_flex().gap(5).child(label("Model")).child(h_flex().gap(5).children(MODELS.map(([k, text]) => chip(`mo-${k || "default"}`, text, this.model === k, () => { this.model = k; }))))))
      .child(div().text_size(11).text_color(this.mode === "bypassPermissions" ? t.blocked : t.dim).child(modeInfo?.[2] ?? ""))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(4).gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child("Runs claude -p in the folder; each run is kept as a session you can open as a chat."))
        .child(button("ce-cancel", "Cancel", false, () => closeOverlay(this.p.overlay)))
        .child(button("ce-save", this.saving ? "Saving…" : this.job ? "Save" : "Create", true, (_e, cx) => this.save(cx))));
  }
}
