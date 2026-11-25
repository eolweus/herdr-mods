// One shell script for macOS and Linux; a bare server may lack jq, python3 or lsof, so it sticks to sh, ss and /proc.
// Every line is "<kind>\t<fields...>", parsed by parseStats.
export const STATS = String.raw`
t=$(printf '\t')
k() { printf 'K%s%s%s%s\n' "$t" "$1" "$t" "$2"; }
if [ "$(uname)" = Darwin ]; then
  k host "$(scutil --get ComputerName 2>/dev/null || hostname)"
  k os "$(sw_vers -productName) $(sw_vers -productVersion)"
  k cores "$(sysctl -n hw.ncpu)"
  k boot "$(sysctl -n kern.boottime | awk -F'[ ,]+' '{print $4}')"
  k load "$(sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1, $2, $3}')"
  k cpu "$(top -l 2 -n 0 -s 1 | grep 'CPU usage' | tail -1 | awk '{gsub("%","",$7); print 100-$7}')"
  k mem_total "$(sysctl -n hw.memsize)"
  ps_=$(sysctl -n hw.pagesize)
  k mem_used "$(vm_stat | awk -v p="$ps_" '/Pages active/ {a=$3} /Pages wired/ {w=$4} /occupied by compressor/ {c=$5} END {gsub("\\.","",a); gsub("\\.","",w); gsub("\\.","",c); print (a+w+c)*p}')"
  k swap "$(sysctl -n vm.swapusage | awk '{gsub("M","",$3); gsub("M","",$6); print $6*1048576, $3*1048576}')"
  k disk "$(df -kP /System/Volumes/Data | awk 'NR==2 {print $3*1024, $2*1024}')"
  lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null | sed "s/^/L$t/"
  lsof -a -d cwd -u "$(id -u)" -Fpn 2>/dev/null | sed "s/^/W$t/"
  ps eww -U "$(id -u)" -o pid=,command= | awk -v t="$t" 'match($0, /HC_TERMINAL_ID=[^ ]+/) {print "E" t $1 t substr($0, RSTART+15, RLENGTH-15)}'
  ps -Ao pid=,comm= | sed "s/^ *\([0-9]*\) /C$t\1$t/"
  ps -Ao pid=,ppid=,pcpu=,rss=,args= | awk -v t="$t" '{a=$5; for (i=6; i<=NF; i++) a=a " " $i; print "P" t $1 t $2 t $3 t $4 t substr(a, 1, 300)}'
  ps -Aro pid=,pcpu=,pmem=,comm= | head -8 | awk -v t="$t" '{c=$4; for (i=5; i<=NF; i++) c=c " " $i; n=split(c, s, "/"); print "T" t $1 t $2 t $3 t s[n]}'
else
  k host "$(hostname)"
  k os "$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
  k cores "$(nproc)"
  k boot "$(( $(date +%s) - $(cut -d. -f1 /proc/uptime) ))"
  k load "$(cut -d' ' -f1-3 /proc/loadavg)"
  a=$(head -1 /proc/stat); sleep 0.5; b=$(head -1 /proc/stat)
  k cpu "$(printf '%s\n%s\n' "$a" "$b" | awk '{i=$5+$6; s=0; for (j=2; j<=NF; j++) s+=$j; if (NR==1) {i1=i; s1=s} else {d=s-s1; print (d>0 ? 100*(d-(i-i1))/d : 0)}}')"
  k mem_total "$(awk '/^MemTotal/ {print $2*1024}' /proc/meminfo)"
  k mem_used "$(awk '/^MemTotal/ {t=$2} /^MemAvailable/ {a=$2} END {print (t-a)*1024}' /proc/meminfo)"
  k swap "$(awk '/^SwapTotal/ {t=$2} /^SwapFree/ {f=$2} END {print (t-f)*1024, t*1024}' /proc/meminfo)"
  k disk "$(df -kP / | awk 'NR==2 {print $3*1024, $2*1024}')"
  ss -Htlnp 2>/dev/null | sed "s/^/S$t/"
  for d in /proc/[0-9]*; do c=$(readlink "$d/cwd" 2>/dev/null) && printf 'W%sp%s\nW%sn%s\n' "$t" "$(basename "$d")" "$t" "$c"; done
  grep -az '^HC_TERMINAL_ID=' /proc/[0-9]*/environ 2>/dev/null | tr '\0' '\n' | sed -n "s|^/proc/\([0-9]*\)/environ:HC_TERMINAL_ID=|E$t\1$t|p"
  ps -eo pid=,ppid=,pcpu=,rss=,args= | awk -v t="$t" '{a=$5; for (i=6; i<=NF; i++) a=a " " $i; print "P" t $1 t $2 t $3 t $4 t substr(a, 1, 300)}'
  command -v docker >/dev/null && docker ps --format '{{.Names}}'"$t"'{{.Ports}}' 2>/dev/null | sed "s/^/D$t/"
  ps -eo pid=,pcpu=,pmem=,args= --sort=-pcpu | head -8 | awk -v t="$t" '{n=split($4, s, "/"); print "T" t $1 t $2 t $3 t s[n]}'
fi
true`;

const num = (s) => Number.parseFloat(s);

export function parseStats(stdout) {
  const kv = {}, cwd = {}, exe = {}, term = {}, procs = new Map(), top = [], ports = new Map(), docker = [];
  const add = (port, addr, pid, name) => {
    const key = `${port}`;
    const p = ports.get(key) ?? { port: Number(port), addrs: new Set(), pid: null, name: null };
    p.addrs.add(addr);
    if (pid && !p.pid) { p.pid = pid; p.name = name; }
    ports.set(key, p);
  };
  let lpid = null, lcmd = null, wpid = null;
  for (const line of stdout.split("\n")) {
    const f = line.split("\t");
    switch (f[0]) {
      case "K": kv[f[1]] = f.slice(2).join("\t"); break;
      case "P": procs.set(f[1], { pid: f[1], ppid: f[2], cpu: num(f[3]), rss: num(f[4]) * 1024, args: f.slice(5).join("\t").trim() }); break;
      case "E": term[f[1]] = f[2]; break;
      case "C": exe[f[1]] = f.slice(2).join("\t"); break;
      case "T": top.push({ pid: f[1], cpu: num(f[2]), mem: num(f[3]), name: f[4] }); break;
      case "W": {
        const v = f.slice(1).join("\t");
        if (v[0] === "p") wpid = v.slice(1);
        else if (v[0] === "n" && wpid) cwd[wpid] = v.slice(1);
        break;
      }
      case "L": {
        const v = f.slice(1).join("\t");
        if (v[0] === "p") lpid = v.slice(1);
        else if (v[0] === "c") lcmd = v.slice(1);
        else if (v[0] === "n") {
          const m = /^(.*):(\d+)$/.exec(v.slice(1));
          if (m) add(m[2], m[1], lpid, lcmd);
        }
        break;
      }
      case "S": {
        const cols = f.slice(1).join("\t").trim().split(/\s+/);
        const m = /^(.*):(\d+)$/.exec(cols[3] ?? "");
        if (!m) break;
        const proc = /\(\("([^"]*)",pid=(\d+)/.exec(cols.slice(5).join(" "));
        add(m[2], m[1], proc?.[2] ?? null, proc?.[1] ?? null);
        break;
      }
      case "D": {
        for (const m of (f[2] ?? "").matchAll(/:(\d+)->(\d+)\/tcp/g)) docker.push({ port: Number(m[1]), inner: Number(m[2]), name: f[1] });
        break;
      }
    }
  }
  for (const d of docker) {
    const p = ports.get(`${d.port}`);
    if (p && !p.pid) { p.docker = d.name; p.inner = d.inner; }
  }
  const pair = (s) => (s ?? "").split(" ").map(num);
  const [swapUsed, swapTotal] = pair(kv.swap);
  const [diskUsed, diskTotal] = pair(kv.disk);
  for (const p of procs.values()) { p.cwd = cwd[p.pid] ?? null; p.exe = exe[p.pid] ?? null; }
  const args = Object.fromEntries([...procs].map(([pid, p]) => [pid, p.args]));
  return {
    procs, term,
    host: kv.host, os: kv.os, cores: Number(kv.cores), boot: Number(kv.boot), load: kv.load,
    cpu: num(kv.cpu), memUsed: num(kv.mem_used), memTotal: num(kv.mem_total),
    swapUsed, swapTotal, diskUsed, diskTotal, top,
    ports: [...ports.values()].sort((a, b) => a.port - b.port).map((p) => ({
      ...p,
      public: [...p.addrs].some((a) => a === "*" || a === "0.0.0.0" || a === "[::]" || a === "::"),
      args: p.pid ? args[p.pid] ?? null : null,
      cwd: p.pid ? cwd[p.pid] ?? null : null,
    })),
  };
}

const base = (path) => (path ?? "").replace(/\/+$/, "").split("/").pop();
const GENERIC = /^(node|nodejs|python[\d.]*|bun|deno|ruby|java|npm|npx|pnpm|yarn|uv|uvx|tsx|ts-node|sh|bash|zsh|dash)$/;
const RUNNERS = /^(npm|npx|pnpm|yarn|bun|uv|uvx|deno)$/;
const BORING = /^(index|main|cli|app|server|run|start|__main__)\.(m?[jt]s|cjs|py)$/;
const SHELL = /^-?(sh|bash|zsh|dash|fish|login)$/;

// Claude Code renames its process to its version ("2.1.325-1ef04b3").
// macOS gives the executable path apart from the arguments, so app paths with spaces survive.
const exeName = (p) => base(p?.exe?.startsWith("/") ? p.exe : p?.args?.split(" ")[0]);

export const isClaude = (p) => {
  const first = exeName(p);
  return first === "claude" || /^\d+\.\d+\.\d+(-[0-9a-f]+)?$/.test(first);
};
export const isShell = (p) => SHELL.test(exeName(p));

// What a generic interpreter is running: the package, script or module after it.
function script(tokens) {
  const runner = RUNNERS.test(base(tokens[0]));
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "-m" && tokens[i + 1]) return tokens[i + 1];
    if (tok === "-c" || tok === "-e") return "inline script";
    if (tok.startsWith("-")) continue;
    if (runner && /^(run|exec|x|dlx|tool)$/.test(tok)) return tokens.slice(i, i + 2).join(" ");
    const nm = tok.split("node_modules/").pop();
    if (nm !== tok) {
      const parts = nm.replace(/^\.bin\//, "").split("/");
      return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    }
    const b = base(tok);
    if (BORING.test(b)) return `${base(tok.slice(0, -b.length - 1))}/${b}`;
    return b.replace(/\.(m?[jt]s|cjs|py)$/, "");
  }
  return null;
}

export function describe(p, fallback) {
  const tokens = (p?.args ?? "").split(" ").filter(Boolean);
  const name = exeName(p) || fallback || "?";
  if (isClaude(p)) return "claude";
  if (!GENERIC.test(name)) return fallback || name;
  const what = script(tokens);
  return what ? `${name} · ${what}` : name;
}

// The process's Herdr terminal: its own HC_TERMINAL_ID, else the nearest ancestor's
// (macOS hides the environment of processes that rewrite their argv).
export function terminalOf(stats, pid) {
  for (let p = stats.procs.get(String(pid)), n = 0; p && n < 64; p = stats.procs.get(p.ppid), n++) {
    if (stats.term[p.pid]) return stats.term[p.pid];
  }
  return null;
}

export function agentOf(stats, pid) {
  let p = stats.procs.get(String(pid));
  for (let n = 0; p && n < 64; p = stats.procs.get(p.ppid), n++) if (n > 0 && isClaude(p)) return p;
  return null;
}

export function children(stats) {
  const kids = new Map();
  for (const p of stats.procs.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  return kids;
}

// Claude Code registers each running CLI in ~/.claude/sessions/<pid>.json; the transcript's newest
// assistant message gives the model, context size and branch. Read only while the Claude section is open.
export const SESSIONS = String.raw`
t=$(printf '\t')
for f in "$HOME"/.claude/sessions/*.json; do
  [ -f "$f" ] || continue
  printf 'R%s%s\n' "$t" "$(tr -d '\n' < "$f")"
  id=$(grep -o '"sessionId":"[^"]*"' "$f" | head -1 | cut -d'"' -f4)
  for j in "$HOME"/.claude/projects/*/"$id".jsonl; do
    [ -n "$id" ] && [ -f "$j" ] || continue
    if [ "$(uname)" = Darwin ]; then m=$(stat -f %m "$j"); else m=$(stat -c %Y "$j"); fi
    tail=$(tail -c 400000 "$j")
    last=$(printf '%s\n' "$tail" | grep '"type":"assistant"' | grep -v '"model":"<synthetic>"' | tail -1)
    model=$(printf '%s' "$last" | grep -o '"model":"[^"]*"' | head -1 | cut -d'"' -f4)
    usage=$(printf '%s' "$last" | grep -o '"usage":{[^}]*' | head -1)
    branch=$(printf '%s\n' "$tail" | grep -o '"gitBranch":"[^"]*"' | tail -1 | cut -d'"' -f4)
    printf 'J%s%s%s%s%s%s%s%s%s%s\n' "$t" "$id" "$t" "$m" "$t" "$model" "$t" "$branch" "$t" "$usage"
    break
  done
done
true`;

export function parseSessions(stdout) {
  const list = [], transcripts = {};
  for (const line of stdout.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "R") {
      try { list.push(JSON.parse(f.slice(1).join("\t"))); } catch {}
    } else if (f[0] === "J") {
      const n = (k) => Number(new RegExp(`"${k}":(\\d+)`).exec(f[5] ?? "")?.[1] ?? 0);
      transcripts[f[1]] = { mtime: Number(f[2]) * 1000, model: f[3] || null, branch: f[4] || null, context: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") };
    }
  }
  return list.map((r) => ({ ...r, transcript: transcripts[r.sessionId] ?? null }));
}
