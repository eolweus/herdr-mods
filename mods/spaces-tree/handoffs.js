// Board handoffs running in each machine's herdr-chat engine, and the pane or handoff that sent each.

import { appHome, exec, home, machines, notify, panes, readTextFile, setShared, shared } from "herdr";

export const HANDOFF = "#a970ff";
// One-off handoffs are purple, orchestrated ones teal, and standalone ones (the person's own) neutral.
const KIND_COLORS = { orchestrated: "#22a99a", standalone: "#8c929c" };
export const kindColor = (h) => KIND_COLORS[h?.kind] ?? HANDOFF;
const PORT = 7777;
// A machine that stops answering keeps its last list this long, so a blip doesn't drop rows.
const KEEP_MS = 30000;
// A close waits for the running turn, then for the board to sync; past this it's given up on.
const CLOSING_MS = 30 * 60000;

const chatKey = (pane) => shared(`herdr-chat:info:${pane}`)?.key ?? null;
export const isHandoffKey = (key) => typeof key === "string" && key.startsWith("board:");

// Handoff ids someone marked done, until their session is gone; the herdr-chat mod writes here too.
export const closing = () => shared("handoffs.closing") ?? {};

// The same signed close as `board close <id>`: the handoff's machine closes it once its turn ends.
export async function markDone(h) {
  setShared("handoffs.closing", { ...closing(), [h.id]: Date.now() });
  const r = await exec("board", ["close", h.id], { timeout: 60000 }).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
  if (r.code === 0) return;
  const { [h.id]: _, ...rest } = closing();
  setShared("handoffs.closing", rest);
  notify({ title: "Couldn't close the handoff", body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
}

export class Handoffs {
  constructor() {
    this.byMachine = new Map(); // machine (null: here) -> { list, at }
    this.ends = new Map();
    this.status = {};
    this.local = null;
  }

  async endpoint(machine) {
    if (this.ends.has(machine)) return this.ends.get(machine);
    let url = `http://127.0.0.1:${PORT}`;
    if (machine) {
      const map = JSON.parse((await readTextFile(`${appHome()}/data/herdr-chat/machines.json`).catch(() => null)) ?? "{}");
      if (map[machine]) url = map[machine].replace(/^ws/, "http").replace(/\/+$/, "");
      else {
        const r = await exec("ssh", ["-G", machine]);
        url = `http://${r.stdout.match(/^hostname (\S+)/m)?.[1] ?? machine}:${PORT}`;
      }
    }
    const r = await exec("sh", ["-c", "cat ~/.config/herdr-chat/token"], { on: machine });
    if (r.code !== 0) return null;
    const end = { url, token: r.stdout.trim() };
    this.ends.set(machine, end);
    return end;
  }

  async poll() {
    this.local ??= (await readTextFile(`${home()}/.config/agent-board/machine`).catch(() => null))?.trim() || "mac";
    const names = [null, ...machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name)];
    await Promise.all(names.map(async (machine) => {
      try {
        const end = await this.endpoint(machine);
        if (!end) return;
        const res = await fetch(`${end.url}/api/handoffs`, { headers: { authorization: `Bearer ${end.token}` } });
        if (res.status === 401) this.ends.delete(machine);
        if (!res.ok) return;
        const { handoffs } = await res.json();
        this.byMachine.set(machine, { list: handoffs.map((h) => ({ ...h, machine })), at: Date.now() });
      } catch {
        const was = this.byMachine.get(machine);
        if (was && Date.now() - was.at > KEEP_MS) this.byMachine.delete(machine);
      }
    }));
    const list = this.list();
    this.alert(list);
    const marks = closing();
    const kept = Object.fromEntries(Object.entries(marks).filter(([id, at]) => Date.now() - at < CLOSING_MS && list.some((h) => h.id === id)));
    if (Object.keys(kept).length !== Object.keys(marks).length) setShared("handoffs.closing", kept);
    const ps = panes();
    const json = JSON.stringify(list.map(({ key, machine, id, title, name, status, result, from, cwd, kind, report }) => {
      const up = this.parent({ from }, ps);
      const fromMachine = this.machineOf(String(from ?? "").split("/")[0]);
      return { key, machine, id, title, name, status, result, from, cwd, kind: kind ?? "once", report: report ?? null, label: this.label(machine), fromMachine, fromLabel: this.label(fromMachine), parent: up?.pane ?? null, parentKey: up?.handoff?.key ?? null };
    }));
    if (json !== this.shared) { this.shared = json; setShared("handoffs", JSON.parse(json)); }
    return list;
  }

  list() {
    return [...this.byMachine.values()].flatMap((m) => m.list);
  }

  // The board names machines by their own name ("mac" here), Herdr by null for this one.
  machineOf(name) {
    return name === this.local ? null : name;
  }

  label(machine) {
    return machine ?? this.local ?? "mac";
  }

  // What sent a handoff: { pane } for one open here, { handoff } for another handoff, else null.
  parent(h, ps = panes()) {
    const at = String(h.from ?? "").indexOf("/");
    if (at < 0) return null;
    const machine = this.machineOf(h.from.slice(0, at));
    const where = h.from.slice(at + 1);
    if (where.startsWith("chat:")) {
      const key = where.slice(5);
      if (isHandoffKey(key)) {
        const up = this.list().find((x) => x.key === key && x.machine === machine);
        return up ? { handoff: up } : null;
      }
      const p = ps.find((x) => x.mod === "herdr-chat" && chatKey(x.pane) === key);
      return p ? { pane: p.pane } : null;
    }
    if (where.startsWith("term:")) {
      const id = where.slice(5);
      const p = ps.find((x) => x.terminal && (x.terminal === id || x.terminal === `${machine}/${id}`));
      return p ? { pane: p.pane } : null;
    }
    const p = ps.find((x) => x.pane === where || x.pane === `${machine}/${where}`);
    return p ? { pane: p.pane } : null;
  }

  // The open chat pane showing a handoff, if any.
  paneOf(h, ps = panes()) {
    return ps.find((x) => x.mod === "herdr-chat" && chatKey(x.pane) === h.key)?.pane ?? null;
  }

  alert(list) {
    const next = {};
    for (const h of list) {
      const id = `${h.machine ?? ""}/${h.key}`;
      next[id] = h.status;
      if (h.status === "blocked" && this.primed && this.status[id] !== "blocked") {
        notify({ title: `Handoff on ${this.label(h.machine)} needs you`, body: h.name ?? h.title ?? h.id, level: "warning" });
      }
    }
    this.status = next;
    this.primed = true;
  }
}
