// Scheduled jobs on one machine: systemd user timers (Linux), launchd agents with a schedule (macOS),
// and crontab lines wherever crontab exists. Lines are "<kind>\t<fields...>".
export const LIST = String.raw`
t=$(printf '\t')
# The first argument that is a script file, if it runs claude -p.
scriptclaude() {
  for w in "$@"; do
    [ -f "$w" ] && grep -Iq . "$w" 2>/dev/null || continue
    grep -Eq '(^|[^#[:alnum:]_./-])claude[[:space:]]+(-p|--print)' "$w" && printf '%s' "$w"
    return
  done
}
printf 'H%s%s\n' "$t" "$HOME"
for d in "$HOME"/.config/herdr-claude/*/; do
  [ -f "$d/job.env" ] || continue
  s=$(basename "$d"); o="$HOME/.local/state/herdr-claude/$s"
  ( . "$d/job.env"; for kv in "name=$NAME" "folder=$FOLDER" "mode=$MODE" "model=$MODEL"; do printf 'K%s%s%s%s\n' "$t" "$s" "$t" "$kv"; done )
  printf 'K%s%s%sprompt=%s\n' "$t" "$s" "$t" "$(head -c 400 "$d/prompt.md" | tr '\n\t' '  ')"
  [ -s "$o/last.json" ] && printf 'K%s%s%slast=%s\n' "$t" "$s" "$t" "$(tr -d '\n' < "$o/last.json")"
  [ -s "$o/runs" ] && printf 'K%s%s%sran=%s\n' "$t" "$s" "$t" "$(tail -1 "$o/runs")"
done
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  # --timestamp=unix doesn't reach LastTriggerUSec on systemd 255, so date converts it.
  stamp() {
    while IFS= read -r l; do
      case "$l" in LastTriggerUSec=?*) v=$(printf '%s' "$l" | cut -d= -f2-); [ "$v" = n/a ] || l="LastTriggerUSec=@$(date -d "$v" +%s 2>/dev/null)" ;; esac
      printf '%s%s%s%s%s\n' "$1" "$t" "$2" "$t" "$l"
    done
  }
  timers=$(systemctl --user list-unit-files '*.timer' --no-legend 2>/dev/null | awk '{print $1}')
  for u in $timers; do
    systemctl --user show "$u" -p Id,Description,TimersCalendar,TimersMonotonic,LastTriggerUSec,UnitFileState,ActiveState,Unit,DropInPaths --timestamp=unix --no-pager 2>/dev/null | stamp U "$u"
    set -- $(systemctl --user show "$u" -p FragmentPath -p DropInPaths --value 2>/dev/null)
    g=$(cat "$@" "$HOME/.config/systemd/user/$u.d/40-herdr-group.conf" 2>/dev/null | sed -n 's/^[[:space:]]*X-Group=[[:space:]]*//p' | tail -1)
    printf 'U%s%s%sXGroup=%s\n' "$t" "$u" "$t" "$g"
    c=$(cat "$@" 2>/dev/null | sed -n 's/^[[:space:]]*X-Herdr-Claude=[[:space:]]*//p' | tail -1)
    printf 'U%s%s%sXClaude=%s\n' "$t" "$u" "$t" "$c"
    svc=$(systemctl --user show "$u" -p Unit --value 2>/dev/null)
    systemctl --user show "$svc" -p Result,ExecMainStatus,ActiveState,ExecStart --no-pager 2>/dev/null | stamp V "$u"
    argv=$(systemctl --user show "$svc" -p ExecStart --value 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p' | head -1)
    printf 'V%s%s%sScriptClaude=%s\n' "$t" "$u" "$t" "$(scriptclaude $argv)"
  done
fi
if [ "$(uname)" = Darwin ]; then
  uid=$(id -u)
  printf 'G%s%s\n' "$t" "$(launchctl print-disabled gui/$uid 2>/dev/null | grep '=> disabled' | sed -E 's/^[[:space:]]*"([^"]+)".*/\1/' | tr '\n' ' ')"
  for f in "$HOME"/Library/LaunchAgents/*.plist; do
    j=$(plutil -convert json -o - "$f" 2>/dev/null) || continue
    case "$j" in *StartInterval*|*StartCalendarInterval*) ;; *) continue ;; esac
    printf 'P%s%s%s%s\n' "$t" "$f" "$t" "$j"
    sc=$(scriptclaude "$(plutil -extract ProgramArguments.0 raw -o - "$f" 2>/dev/null)" "$(plutil -extract ProgramArguments.1 raw -o - "$f" 2>/dev/null)")
    [ -n "$sc" ] && printf 'Q%s%s%s\n' "$t" "$f" "$t$sc"
    l=$(plutil -extract Label raw -o - "$f" 2>/dev/null)
    launchctl print "gui/$uid/$l" 2>/dev/null | grep -E "^$t(state|last exit code|runs) =" | sed "s/^/S$t$l$t/"
  done
fi
if command -v crontab >/dev/null; then
  crontab -l 2>/dev/null | sed "s/^/C$t/"
fi
true`;

export const ACTIONS = {
  systemd: {
    pause: `systemctl --user disable --now "$1"`,
    resume: `systemctl --user enable --now "$1"`,
    run: `systemctl --user start --no-block "$2"`,
    schedule: String.raw`
systemd-analyze calendar "$2" >/dev/null 2>&1 || { echo "systemd doesn't understand \"$2\"" >&2; exit 2; }
d="$HOME/.config/systemd/user/$1.d"; mkdir -p "$d"
printf '[Timer]\nOnCalendar=\nOnCalendar=%s\n' "$2" > "$d/50-herdr-schedule.conf"
systemctl --user daemon-reload
systemctl --user is-active -q "$1" && systemctl --user restart "$1"
true`,
    reset: String.raw`
rm -f "$HOME/.config/systemd/user/$1.d/50-herdr-schedule.conf"
rmdir "$HOME/.config/systemd/user/$1.d" 2>/dev/null
systemctl --user daemon-reload
systemctl --user is-active -q "$1" && systemctl --user restart "$1"
true`,
    // systemd ignores X- keys, so the tag can live in the unit itself.
    group: String.raw`
d="$HOME/.config/systemd/user/$1.d"
if [ -n "$2" ]; then mkdir -p "$d"; printf '[Unit]\nX-Group=%s\n' "$2" > "$d/40-herdr-group.conf"
else rm -f "$d/40-herdr-group.conf"; rmdir "$d" 2>/dev/null; fi
systemctl --user daemon-reload
true`,
  },
  launchd: {
    pause: `launchctl bootout "gui/$(id -u)/$1" 2>/dev/null; launchctl disable "gui/$(id -u)/$1"`,
    resume: `launchctl enable "gui/$(id -u)/$1"; launchctl bootstrap "gui/$(id -u)" "$2" 2>/dev/null; true`,
    run: `launchctl kickstart "gui/$(id -u)/$1"`,
    // $3: StartInterval or StartCalendarInterval, $4: its value as JSON.
    schedule: String.raw`
plutil -remove StartInterval "$2" 2>/dev/null
plutil -remove StartCalendarInterval "$2" 2>/dev/null
plutil -insert "$3" -json "$4" "$2" || exit 1
if launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$2"
fi
true`,
    group: `if [ -n "$3" ]; then plutil -replace HerdrGroup -string "$3" "$2"; else plutil -remove HerdrGroup "$2" 2>/dev/null; true; fi`,
  },
  cron: {
    pause: `crontab -l | awk -v L="$1" '$0 == L { print "#herdr-paused# " $0; next } { print }' | crontab -`,
    resume: `crontab -l | awk -v L="#herdr-paused# $1" '$0 == L { sub(/^#herdr-paused# /, ""); print; next } { print }' | crontab -`,
    run: `nohup sh -c "$2" >/dev/null 2>&1 &`,
    // $1: the old line, $2: the new one.
    schedule: `crontab -l | awk -v L="$1" -v N="$2" '$0 == L { print N; next } { print }' | crontab -`,
    // A "# herdr-group: <name>" line right above a job tags that one job.
    group: String.raw`crontab -l | awk -v L="$1" -v G="$2" '
{ a[NR] = $0 }
END {
  for (i = 1; i <= NR; i++) {
    if (a[i] ~ /^# herdr-group: / && (a[i+1] == L || a[i+1] == "#herdr-paused# " L)) continue
    if ((a[i] == L || a[i] == "#herdr-paused# " L) && G != "") print "# herdr-group: " G
    print a[i]
  }
}' | crontab -`,
  },
};

const MONO = { OnUnitActiveUSec: "every", OnUnitInactiveUSec: "every", OnBootUSec: "after boot +", OnStartupUSec: "after login +", OnActiveUSec: "after start +" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");

export function intervalWords(secs) {
  if (secs % 86400 === 0) return `every ${secs / 86400}d`;
  if (secs % 3600 === 0) return `every ${secs / 3600}h`;
  if (secs % 60 === 0) return `every ${secs / 60}m`;
  return `every ${secs}s`;
}

function calendarWords(cal) {
  const list = Array.isArray(cal) ? cal : [cal];
  const time = (c) => (c.Hour != null ? `${pad(c.Hour)}:${pad(c.Minute ?? 0)}` : c.Minute != null ? `hourly at :${pad(c.Minute)}` : "every minute");
  const days = list.map((c) => c.Weekday).filter((d) => d != null);
  const t0 = time(list[0]);
  if (days.length === list.length && days.length) {
    const sorted = [...new Set(days.map((d) => d % 7))].sort();
    const range = sorted.join() === "1,2,3,4,5" ? "Mon-Fri" : sorted.map((d) => WEEKDAYS[d]).join(",");
    return `${range} ${t0}`;
  }
  if (list.length === 1 && list[0].Day != null) return `monthly day ${list[0].Day} ${t0}`;
  return list.length === 1 && list[0].Hour != null ? `daily ${t0}` : list.map(time).join(", ");
}

// "every 30m", "daily 09:15", "09:15", "Mon-Fri 09:15", "Sat,Sun 10:00" -> launchd keys.
export function parseLaunchd(text) {
  const s = text.trim();
  let m = /^(?:every\s+)?(\d+)\s*(s|m|h|d)$/i.exec(s);
  if (m) {
    const secs = Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
    return secs > 0 ? { key: "StartInterval", value: secs } : null;
  }
  m = /^(?:(daily|[a-z,\-]+)\s+)?(\d{1,2}):(\d{2})$/i.exec(s);
  if (!m) return null;
  const at = { Hour: Number(m[2]), Minute: Number(m[3]) };
  if (at.Hour > 23 || at.Minute > 59) return null;
  const days = (m[1] ?? "daily").toLowerCase();
  if (days === "daily") return { key: "StartCalendarInterval", value: at };
  const idx = (d) => WEEKDAYS.findIndex((w) => w.toLowerCase() === d.slice(0, 3));
  const picked = new Set();
  for (const part of days.split(",")) {
    const [a, b] = part.split("-").map(idx);
    if (a < 0 || (b !== undefined && b < 0)) return null;
    if (b === undefined) picked.add(a);
    else for (let d = a; ; d = (d + 1) % 7) { picked.add(d); if (d === b) break; }
  }
  return { key: "StartCalendarInterval", value: [...picked].sort().map((d) => ({ ...at, Weekday: d })) };
}

// "every 30m" / "every 2h" as a systemd calendar; anything else goes to systemd-analyze as written.
export function systemdCalendar(text) {
  const s = text.trim();
  const m = /^every\s+(\d+)\s*(m|h)$/i.exec(s);
  if (!m) return s;
  const n = Number(m[1]);
  return m[2].toLowerCase() === "m" ? `*:0/${n}` : `0/${n}:00`;
}

const unix = (v) => {
  const m = /@(\d+)/.exec(v ?? "");
  return m ? Number(m[1]) * 1000 : null;
};

// A command that starts claude itself, not a script that might.
// A unit whose description names claude, for programs that call it from inside (e.g. Python).
const CLAUDE_HINT = /\bclaude\b/i;
const CLAUDE_CMD = /(^|[\s\/'"=])claude(\s|$|['"])/;

function claudeRun(r) {
  if (!r) return null;
  let last = null;
  try { last = r.last ? JSON.parse(r.last) : null; } catch {}
  const [ranAt, code] = (r.ran ?? "").split(" ");
  return { ...r, last, exit: code ?? null, ranAt: ranAt || null };
}

export function parseJobs(stdout, machine) {
  const units = {}, services = {}, launchd = [], status = {}, cron = [], runs = {};
  let home = null;
  const scripts = {};
  let disabled = new Set();
  for (const line of stdout.split("\n")) {
    const f = line.split("\t");
    const kv = (s) => { const i = s.indexOf("="); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]; };
    if (f[0] === "U" && f[2]) { const [k, v] = kv(f.slice(2).join("\t")); (units[f[1]] ??= {})[k] = v; }
    else if (f[0] === "V" && f[2]) { const [k, v] = kv(f.slice(2).join("\t")); (services[f[1]] ??= {})[k] = v; }
    else if (f[0] === "G") disabled = new Set((f[1] ?? "").split(" ").filter(Boolean));
    else if (f[0] === "P") { try { launchd.push({ path: f[1], plist: JSON.parse(f.slice(2).join("\t")) }); } catch {} }
    else if (f[0] === "S") { const [k, v] = f.slice(2).join("\t").trim().split(" = "); (status[f[1]] ??= {})[k] = v; }
    else if (f[0] === "C") cron.push(f.slice(1).join("\t"));
    else if (f[0] === "H") home = f[1];
    else if (f[0] === "Q") scripts[f[1]] = f[2];
    else if (f[0] === "K" && f[2]) { const [k, v] = kv(f.slice(2).join("\t")); (runs[f[1]] ??= { slug: f[1] })[k] = v; }
  }

  const jobs = [];
  for (const [id, u] of Object.entries(units)) {
    const svc = services[id] ?? {};
    const calendars = [...(u.TimersCalendar ?? "").matchAll(/OnCalendar=([^;]+?)\s*;\s*next_elapse=([^ }]+)/g)];
    const mono = [...(u.TimersMonotonic ?? "").matchAll(/(On\w+Sec)=(\w+)/g)].map((m) => `${MONO[m[1]] ?? m[1]} ${m[2]}`);
    const next = calendars.map((c) => unix(c[2])).filter(Boolean).sort()[0] ?? null;
    const ours = (u.DropInPaths ?? "").includes("50-herdr-schedule.conf");
    jobs.push({
      id: `systemd:${id}`, kind: "systemd", machine, name: id.replace(/\.timer$/, ""), unit: id, service: u.Unit,
      about: u.Description, schedule: calendars.map((c) => c[1].trim()).join(", ") || mono.join(", ") || "–",
      editable: calendars[0]?.[1]?.trim() ?? "",
      next, last: unix(u.LastTriggerUSec), paused: u.UnitFileState !== "enabled" && u.ActiveState !== "active",
      running: svc.ActiveState === "active" || svc.ActiveState === "activating",
      failed: svc.Result && svc.Result !== "success", exit: svc.ExecMainStatus, overridden: ours,
      tag: u.XGroup || null, template: u.Unit?.includes("@") ? u.Unit.split("@")[0] : null,
      claude: claudeRun(runs[u.XClaude]), script: svc.ScriptClaude || null,
      runsClaude: CLAUDE_CMD.test(svc.ExecStart ?? "") || Boolean(svc.ScriptClaude) || CLAUDE_HINT.test(u.Description ?? ""),
    });
  }
  for (const { path, plist } of launchd) {
    const label = plist.Label;
    const st = status[label] ?? {};
    const schedule = plist.StartInterval ? intervalWords(plist.StartInterval) : calendarWords(plist.StartCalendarInterval);
    const exitCode = st["last exit code"];
    jobs.push({
      id: `launchd:${label}`, kind: "launchd", machine, name: label, path, about: (plist.ProgramArguments ?? [plist.Program]).join(" "),
      schedule, editable: schedule, next: null, last: null, paused: disabled.has(label) || !st.state,
      running: st.state === "running", failed: exitCode && exitCode !== "0" && !/never exited/.test(exitCode), exit: exitCode,
      logs: plist.StandardOutPath ?? plist.StandardErrorPath ?? null,
      claude: claudeRun(runs[plist.HerdrClaude]), script: scripts[path] ?? null,
      runsClaude: CLAUDE_CMD.test((plist.ProgramArguments ?? [plist.Program]).join(" ")) || Boolean(scripts[path]),
      tag: plist.HerdrGroup || null, base: label.split(".").length > 2 ? label.split(".").slice(2).join(".") : label,
    });
  }
  let tag = null;
  for (const line of cron) {
    const above = tag;
    tag = /^# herdr-group: (.+)$/.exec(line)?.[1].trim() || null;
    const paused = line.startsWith("#herdr-paused# ");
    const body = paused ? line.slice("#herdr-paused# ".length) : line;
    if (!paused && (/^\s*#/.test(body) || !body.trim() || /^\s*\w+=/.test(body))) continue;
    const m = /^\s*(@\w+|(?:\S+\s+){4}\S+)\s+(.*)$/.exec(body);
    if (!m) continue;
    jobs.push({
      id: `cron:${body}`, kind: "cron", machine, name: m[2].split(/\s+/)[0].split("/").pop(), line: body, command: m[2],
      about: m[2], schedule: m[1], editable: m[1], next: null, last: null, paused, running: false, failed: false, tag: above, runsClaude: CLAUDE_CMD.test(m[2]),
    });
  }
  for (const j of jobs) j.home = home;
  return jobs.sort((a, b) => (a.paused - b.paused) || ((a.next ?? Infinity) - (b.next ?? Infinity)) || a.name.localeCompare(b.name));
}

const NONE = "";

// Each job's group, across all machines: its tag, else its systemd template ("atrader@x"),
// else the longest dash-prefix of its name it shares with another job or group.
export function assignGroups(jobs) {
  const fixed = new Set();
  for (const j of jobs) {
    j.group = j.tag || j.template || (j.claude ? "Claude runs" : null);
    if (j.group) fixed.add(j.group);
  }
  const names = jobs.filter((j) => !j.group).map((j) => j.base ?? j.name);
  for (const j of jobs) {
    if (j.group) continue;
    const name = j.base ?? j.name;
    const parts = name.split("-");
    for (let n = parts.length; n > 0 && !j.group; n--) {
      const p = parts.slice(0, n).join("-");
      const others = names.filter((x) => x !== name && (x === p || x.startsWith(`${p}-`))).length;
      if (fixed.has(p) || (others && (n > 1 || p.length > 3))) j.group = p;
    }
    j.group ??= NONE;
  }
  return jobs;
}

// One job in full: its unit (or plist / crontab line), the script it runs and its latest log.
// $1 kind, $2 unit / plist path / cron command, $3 service / log file. Sections start with "\x1e<name>\t<title>".
export const DETAIL = String.raw`
rs=$(printf '\036'); t=$(printf '\t')
script() {
  for w in "$@"; do
    case "$w" in -*|*=*) continue ;; esac
    p="$w"; [ -f "$p" ] || p=$(command -v "$w" 2>/dev/null) || continue
    [ -f "$p" ] && grep -Iq . "$p" 2>/dev/null || continue
    printf '%sscript%s%s\n' "$rs" "$t" "$p"; head -c 60000 "$p"; echo
    return
  done
}
case "$1" in
systemd)
  wd=$(systemctl --user show "$3" -p WorkingDirectory --value 2>/dev/null | sed 's/^!//')
  [ -n "$wd" ] && wd="in $wd"
  printf '%scommand%s%s\n' "$rs" "$t" "$wd"
  systemctl --user show "$3" -p ExecStart --value 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p'
  printf '%sunit%sunit files\n' "$rs" "$t"; systemctl --user cat "$2" "$3" 2>&1
  script $(systemctl --user show "$3" -p ExecStart --value 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p' | head -1)
  printf '%slog%sjournalctl --user -u %s\n' "$rs" "$t" "$3"; journalctl --user -u "$3" -n 25 --no-pager -o short-iso 2>&1 ;;
launchd)
  printf '%scommand%s\n' "$rs" "$t"
  i=0; while a=$(plutil -extract "ProgramArguments.$i" raw -o - "$2" 2>/dev/null); do printf '%s ' "$a"; i=$((i + 1)); done; echo
  printf '%sunit%s%s\n' "$rs" "$t" "$2"; plutil -convert xml1 -o - "$2" 2>&1
  script $(plutil -extract ProgramArguments.0 raw -o - "$2" 2>/dev/null) $(plutil -extract ProgramArguments.1 raw -o - "$2" 2>/dev/null)
  [ -n "$3" ] && [ -f "$3" ] && { printf '%slog%s%s\n' "$rs" "$t" "$3"; tail -n 25 "$3"; } ;;
cron)
  printf '%sunit%scrontab line\n' "$rs" "$t"; printf '%s\n' "$2"
  script $2 ;;
esac
true`;

export function parseDetail(stdout) {
  return stdout.split("\x1e").filter(Boolean).map((chunk) => {
    const nl = chunk.indexOf("\n");
    const [kind, title] = (nl < 0 ? chunk : chunk.slice(0, nl)).split("\t");
    const lines = (nl < 0 ? "" : chunk.slice(nl + 1)).replace(/\n+$/, "").split("\n");
    return { kind, title, lines };
  });
}
