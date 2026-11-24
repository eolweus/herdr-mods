import { exec, hc, readTextFile, setShared, writeTextFile } from "herdr";

// port<TAB>pid<TAB>cwd<TAB>args<TAB>status|content-type of / ("000": not http)<TAB>git root for this user's TCP listeners on ports >= 1024.
export const LISTEN = `
me=$(id -u)
if [ "$(uname)" = Darwin ]; then
  lsof -nP -a -u "$me" -iTCP -sTCP:LISTEN -Fpn 2>/dev/null | awk '/^p/{p=substr($0,2)} /^n/{n=$0; sub(/.*:/,"",n); print n"\\t"p}'
else
  ss -ltnpH 2>/dev/null | awk '{n=$4; sub(/.*:/,"",n); if (match($0,/pid=[0-9]+/)) print n"\\t"substr($0,RSTART+4,RLENGTH-4)}'
fi | sort -u | while IFS="$(printf '\\t')" read -r port pid; do
  [ "$port" -ge 1024 ] 2>/dev/null || continue
  if [ -d /proc ]; then cwd=$(readlink "/proc/$pid/cwd"); args=$(tr '\\0' ' ' <"/proc/$pid/cmdline")
  else cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'); args=$(ps -o args= -p "$pid"); fi
  code=$(curl -s -m 1 -o /dev/null -w '%{http_code}|%{content_type}' "http://127.0.0.1:$port/" 2>/dev/null)
  repo=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
  unit=$(sed -n 's|^0::/user.slice/.*/\\([^/]*\\.service\\)$|\\1|p' "/proc/$pid/cgroup" 2>/dev/null)
  case "$unit" in app-*|*@*) unit= ;; esac
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$port" "$pid" "$cwd" "$args" "\${code:-000}" "$repo" "$unit"
done
# Every running compose container, by project (from its labels); port is "-" when it publishes none, pid is docker:<project>.
command -v docker >/dev/null 2>&1 && docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.service"}}|{{.Image}}|{{.Ports}}' 2>/dev/null |
while IFS='|' read -r proj dir svc image ports; do
  [ -n "$proj" ] && [ -n "$dir" ] || continue
  repo=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
  found=
  for port in $(echo "$ports" | tr ',' '\\n' | sed -n 's/.*:\\([0-9][0-9]*\\)->.*/\\1/p' | sort -u); do
    code=$(curl -s -m 1 -o /dev/null -w '%{http_code}|%{content_type}' "http://127.0.0.1:$port/" 2>/dev/null)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$port" "docker:$proj" "$dir" "$svc $image" "\${code:-000}" "$repo"
    found=1
  done
  [ -n "$found" ] || printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "-" "docker:$proj" "$dir" "$svc $image" "000" "$repo"
done
true
`;

// mtime<TAB>path for .html files Claude sessions wrote in the last 30 days that still exist.
export const HTML = `
pat='"name":"Write","input":\\{"file_path":"[^"]*\\.html"'
find "$HOME/.claude/projects" -name '*.jsonl' -mtime -30 -print0 2>/dev/null | {
  if command -v rg >/dev/null; then xargs -0 rg -oN --no-filename "$pat"; else xargs -0 grep -Eho "$pat"; fi
} 2>/dev/null | sed 's/.*"file_path":"//; s/"$//' | sort -u | while IFS= read -r f; do
  [ -f "$f" ] || continue
  printf '%s\\t%s\\n' "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")" "$f"
done | sort -rn | head -150
`;

const FREE_PORT = `python3 -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])'`;
const PROBE = `curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/" 2>/dev/null || true`;

export const sh = (script, args, on, timeout = 30000) => exec("sh", ["-c", script, "sh", ...args], { on, timeout });

// Infrastructure that listens on ports but isn't an app you'd launch.
const NOISE = /claude|ccd-cli|agent-browser|terminal-browser|herdr|raycast|spotify|logi|code helper|cursor|zed/i;
const OWN = /\/herdr-chat\/engine$/;

// One entry per repo (or folder, outside git), holding every process listening from it.
export function parseListeners(stdout, machine) {
  const byPid = new Map();
  for (const line of stdout.split("\n")) {
    const [port, pid, cwd, args, code, repo, unit] = line.split("\t");
    if (!port || !cwd || !/^\/(Users|home)\//.test(cwd) || NOISE.test(args ?? "") || OWN.test(cwd)) continue;
    const docker = pid.startsWith("docker:") ? pid.slice(7) : null;
    const p = byPid.get(pid) ?? { pid, docker, cwd, repo: repo || cwd, args: docker ? `docker compose -p ${docker}` : (args ?? "").trim(), ports: [], http: [], pages: [], services: [], unit: unit || null };
    byPid.set(pid, p);
    const n = Number(port);
    if (docker) {
      const [name, image] = (args ?? "").trim().split(" ");
      const svc = p.services.find((x) => x.name === name) ?? (p.services.push({ name, image, ports: [] }), p.services.at(-1));
      if (port !== "-" && !svc.ports.includes(n)) svc.ports.push(n);
    }
    if (port === "-") continue;
    const [status, type] = (code ?? "000").split("|");
    if (!p.ports.includes(n)) p.ports.push(n);
    if (status !== "000" && !p.http.includes(n)) p.http.push(n);
    if (/^[23]/.test(status) && /html/.test(type ?? "") && !p.pages.includes(n)) p.pages.push(n);
  }
  for (const [pid, p] of byPid) if (!p.ports.length) byPid.delete(pid);
  const byRepo = new Map();
  for (const p of byPid.values()) {
    const g = byRepo.get(p.repo) ?? { machine, repo: p.repo, cwd: p.repo, procs: [] };
    g.procs.push(p);
    byRepo.set(p.repo, g);
  }
  return [...byRepo.values()].map((g) => {
    g.procs.sort((a, b) => (b.http.length > 0) - (a.http.length > 0) || a.cwd.length - b.cwd.length);
    const ports = g.procs.flatMap((p) => p.ports).sort((a, b) => a - b);
    const pages = g.procs.flatMap((p) => p.pages).sort((a, b) => a - b);
    const http = [...pages, ...g.procs.flatMap((p) => p.http).filter((x) => !pages.includes(x)).sort((a, b) => a - b)];
    return { ...g, id: `${machine ?? "local"}:${g.repo}`, ports, http, pages, likely: pages.length > 0, port: http[0] ?? ports[0] };
  });
}

// One row per folder: index.html if there is one, else the newest file.
export function parseHtml(stdout, machine) {
  const byDir = new Map();
  for (const line of stdout.split("\n")) {
    const [m, path] = line.split("\t");
    if (!path) continue;
    const dir = path.slice(0, path.lastIndexOf("/"));
    const d = byDir.get(dir) ?? { machine, dir, files: [], mtime: 0 };
    d.files.push(path);
    d.mtime = Math.max(d.mtime, Number(m) * 1000);
    byDir.set(dir, d);
  }
  return [...byDir.values()].map((d) => ({
    ...d,
    id: `${machine ?? "local"}:${d.dir}`,
    main: d.files.find((f) => f.endsWith("/index.html")) ?? d.files[0],
  })).sort((a, b) => b.mtime - a.mtime).slice(0, 30);
}

export async function freePort(machine) {
  const r = await sh(FREE_PORT, [], machine);
  const port = Number(r.stdout.trim());
  if (!port) throw new Error(r.stderr.trim() || "couldn't find a free port");
  return port;
}

export async function probe(machine, port) {
  const r = await sh(PROBE, [String(port)], machine, 5000).catch(() => null);
  const code = r?.stdout.trim() ?? "000";
  return code !== "" && code !== "000";
}

// Running things are hc terminals named app-<id>-<port> (saved apps) or html-<key>-<port> (served HTML folders).
export async function running() {
  const r = await hc(["ls", "--json"]);
  const out = [];
  for (const t of JSON.parse(r.stdout || "{}").terminals ?? []) {
    if (t.state !== "live") continue;
    const tun = /^tunnel-(.+)-(\d+)-(\d+)$/.exec(t.name ?? "");
    if (tun) { out.push({ kind: "tunnel", id: tun[1], port: Number(tun[2]), remote: Number(tun[3]), address: t.address, machine: null }); continue; }
    const m = /^(app|html)-(.+)-(\d+)$/.exec(t.name ?? "");
    if (!m) continue;
    const slash = t.address.indexOf("/");
    out.push({ kind: m[1], id: m[2], port: Number(m[3]), address: t.address, machine: slash > 0 ? t.address.slice(0, slash) : null });
  }
  return out;
}

// Starts a command in its own hc terminal through the machine's login shell, with $PORT set.
export async function launch(name, machine, folder, command, port) {
  const r = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", name, ...(machine ? ["--on", machine] : []),
    ...(folder ? ["--cwd", folder] : []), "--", "sh", "-c", 'exec "${SHELL:-sh}" -lic "$1"', "sh", `export PORT=${port}; ${command}`]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || "hc run failed");
  return JSON.parse(r.stdout).address;
}

// An app's own stop command, run like its start command.
export async function runStop(app, port) {
  const r = await sh('cd "$1" && exec "${SHELL:-sh}" -lic "$2"', [app.folder, `export PORT=${port ?? ""}; ${app.stop}`], app.machine, 120000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || "stop command failed");
}

export async function stop(address) {
  await hc(["kill", address]);
  await hc(["rm", address]).catch(() => null);
}

// systemd user services get systemctl --user stop (a kill would just be restarted); other processes get a kill; compose projects (pid docker:<project>) get docker compose stop.
export async function stopProcs(machine, procs) {
  const units = [...new Set(procs.filter((p) => p.unit).map((p) => p.unit))];
  if (units.length) await sh('systemctl --user stop "$@"', units, machine);
  const pids = procs.filter((p) => !p.docker && !p.unit).map((p) => p.pid);
  if (pids.length) await sh('kill "$@"', pids, machine);
  for (const p of procs.filter((p) => p.docker)) await sh('docker compose -p "$1" stop', [p.docker], machine, 120000);
}

// systemd user services. Exit 3: no systemd on that machine.
const UNIT_STATE = `command -v systemctl >/dev/null || exit 3
for u in "$@"; do printf '%s\t%s\t%s\n' "$u" "$(systemctl --user is-active "$u" 2>/dev/null)" "$(systemctl --user is-enabled "$u" 2>/dev/null)"; done`;

export async function unitStates(machine, units) {
  const r = await sh(UNIT_STATE, units, machine);
  if (r.code === 3) return { systemd: false, states: {} };
  const states = {};
  for (const line of r.stdout.split("\n")) {
    const [unit, active, enabled] = line.split("\t");
    if (unit) states[unit] = { active, enabled };
  }
  return { systemd: r.code === 0, states };
}

export async function systemctl(machine, ...args) {
  const r = await sh('systemctl --user "$@"', args, machine, 120000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `systemctl ${args.join(" ")} failed`);
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const INSTALL = `set -e
d="$HOME/.local/share/herdr-apps"; u="$HOME/.config/systemd/user"
mkdir -p "$d" "$u"
printf '%s' "$2" > "$d/$1.sh"; chmod +x "$d/$1.sh"
rm -f "$d/$1-stop.sh"
if [ -n "$3" ]; then printf '%s' "$3" > "$d/$1-stop.sh"; chmod +x "$d/$1-stop.sh"; fi
printf '%s' "$4" > "$u/herdr-app-$1.service"
systemctl --user daemon-reload`;

// Writes a user service that runs the app's command like Herdr does (login shell, folder, $PORT) and restarts it when it dies.
export async function installService(app, port) {
  const wrap = (cmd) => `#!/bin/sh\ncd ${q(app.folder)} || exit 1\nexport PORT=${port}\nexec "$(getent passwd "$(id -un)" | cut -d: -f7)" -lic ${q(cmd)}\n`;
  const unit = `[Unit]
Description=${app.name} (Herdr app)
After=network.target

[Service]
ExecStart=%h/.local/share/herdr-apps/${app.id}.sh
${app.stop ? `ExecStop=%h/.local/share/herdr-apps/${app.id}-stop.sh\n` : ""}Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  const r = await sh(INSTALL, [app.id, wrap(app.command), app.stop ? wrap(app.stop) : "", unit], app.machine);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "couldn't write the service");
  return `herdr-app-${app.id}.service`;
}

export const urlFor = (machine, port, path = "/") => `http://${machine ?? "localhost"}:${port}${path.startsWith("/") ? path : `/${path}`}`;
export const openInChrome = (target) => exec("open", ["-a", "Google Chrome", target]);

export const slug = (s, taken = new Set()) => {
  const base = (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app").slice(0, 16).replace(/-$/, "");
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, 13)}-${i}`;
  return id;
};

export const hash = (s) => {
  let h = 5381;
  for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36);
};

// The registry lives in dotfiles behind a symlink; write the real file so the link survives the atomic replace.
let registryPath = null;
async function path() {
  if (registryPath) return registryPath;
  const r = await sh('f="$HOME/.config/herdr-app/apps.json"; if [ -L "$f" ]; then readlink -f "$f"; else echo "$f"; fi', []);
  registryPath = r.stdout.trim();
  return registryPath;
}

export async function loadRegistry() {
  const text = await readTextFile(await path());
  let data = {};
  try { data = JSON.parse(text || "{}"); } catch {}
  return { text, data: { apps: data.apps ?? [], links: data.links ?? [] } };
}

export async function updateRegistry(change) {
  for (let i = 0; i < 3; i++) {
    const { text, data } = await loadRegistry();
    change(data);
    try {
      await writeTextFile(await path(), `${JSON.stringify(data, null, 2)}\n`, text);
      setShared("artifacts.changed", Date.now());
      return data;
    } catch (e) {
      if (i === 2) throw e;
    }
  }
}

export function setupPrompt(g) {
  const line = (p) => p.docker
    ? `- docker compose project "${p.docker}" started from ${p.cwd}, publishing ${p.ports.join(", ")}; services: ${p.services.map((x) => `${x.name} (${x.image}${x.ports.length ? `, port ${x.ports.join(", ")}` : ""})`).join(", ")}`
    : `- pid ${p.pid}, listening on ${p.ports.join(", ")}, cwd ${p.cwd}, command: ${p.args}`;
  return `A local web app is running on this machine and I want to be able to start and stop it later from a launcher.
${g.procs.length > 1 ? "These all run out of the same repo, likely one app plus its helpers (a dev script, an API, a database, a stand-in service):" : "What's running:"}
${g.procs.map(line).join("\n")}

Inspect the project (package.json, compose files, Dockerfiles, scripts, README, config, how the port is chosen) without changing anything, and work out:
- the folder to start it from
- a single shell command that starts all of it from scratch and stays in the foreground, with the web UI listening on the port in $PORT. Use the project's own way to pick the port (env var, --port flag, config) and wire $PORT into it. Include needed steps like activating a venv, but no installs.
- for Docker Compose: start with \`docker compose up\` in the foreground (no -d), with the same -f/-p/--profile flags the running project uses (the project name above), and add --build if the app's image is built from the repo. If the published port comes from an env var in the compose file, set that var from $PORT; otherwise it is fixed.
- a stop command if stopping the foreground process isn't enough to stop everything (for Compose, \`docker compose stop\` with the same flags); else null.
- whether it can listen on any port. If the port is hard-coded and can't be changed without editing files, set fixedPort to it and don't use $PORT.
- whether it needs to bind 0.0.0.0 to be reachable from another machine, and make the command do that if the project supports it.
- the URL path to open (usually "/").

Reply with only a JSON object, no prose:
{"name": "short human name", "folder": "/abs/path", "command": "...", "stop": null, "fixedPort": null, "path": "/", "notes": "one sentence on anything surprising"}`;
}

export async function investigate(p) {
  const r = await sh('cd "$1" && claude -p "$2" --output-format json --allowedTools "Read Glob Grep" --disallowedTools "Edit Write Bash NotebookEdit"',
    [p.repo, setupPrompt(p)], p.machine, 600000);
  let result;
  try { result = JSON.parse(r.stdout).result; } catch { throw new Error(r.stderr.trim() || r.stdout.slice(0, 300) || "claude gave no answer"); }
  const json = /\{[\s\S]*\}/.exec(result ?? "")?.[0];
  if (!json) throw new Error(`no setup in the answer: ${String(result).slice(0, 200)}`);
  const s = JSON.parse(json);
  return { name: s.name ?? p.repo.split("/").pop(), machine: p.machine, folder: s.folder ?? p.cwd, command: s.command ?? "", stop: s.stop || null, port: s.fixedPort ?? null, path: s.path ?? "/", notes: s.notes ?? "" };
}

const SHOTS = "data/artifacts/shots";
let queue = Promise.resolve();

// Headless Chrome (shot.ts) with its own profile, one at a time, after the page has loaded and gone quiet. Returns the path relative to the app home (what image() takes).
export function capture(appHome, key, target) {
  const name = `${key.split(":")[0]}-${hash(key)}-${Date.now().toString(36)}.png`;
  const run = async () => {
    await exec("mkdir", ["-p", `${appHome}/${SHOTS}`]);
    const r = await sh('exec "$HOME/.bun/bin/bun" "$@"', [`${appHome}/mods/artifacts/shot.ts`, target, `${appHome}/${SHOTS}/${name}`, `${appHome}/data/artifacts/chrome`], null, 45000);
    if (!/bytes written to file/.test(r.stderr + r.stdout)) throw new Error(r.stderr.trim() || "no screenshot");
    return `${SHOTS}/${name}`;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => null);
  return p;
}

export async function reachable(url) {
  const r = await exec("curl", ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", url]).catch(() => null);
  return Boolean(r && r.stdout.trim() !== "000" && r.stdout.trim() !== "");
}

// A remote app that only listens on its machine's localhost: forward it with ssh and use localhost here.
export async function tunnel(machine, port, live) {
  const open = live.find((r) => r.kind === "tunnel" && r.id === machine && r.remote === port);
  if (open) return open.port;
  let local = port;
  if (await reachable(`http://localhost:${port}/`)) local = await freePort(null);
  const name = `tunnel-${machine}-${local}`;
  const r = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", `${name}-${port}`, "--",
    "ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-L", `${local}:127.0.0.1:${port}`, machine]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "ssh tunnel failed");
  for (let i = 0; i < 20 && !(await reachable(`http://localhost:${local}/`)); i++) await exec("sleep", ["0.25"]);
  return local;
}

// Where this Mac reaches a port on a machine: directly, or through a tunnel.
export async function reach(machine, port, live) {
  if (!machine) return `http://localhost:${port}`;
  if (await reachable(`http://${machine}:${port}/`)) return `http://${machine}:${port}`;
  return `http://localhost:${await tunnel(machine, port, live)}`;
}
