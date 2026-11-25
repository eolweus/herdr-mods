import { View, div } from "gpui-kit";
import { checking, closeOverlay, focused, layout, notify, panes, props, run, setShared, shared, terminals, window } from "herdr";

// Shared by every sidebar-* mod as a hard link: mods can't import outside their own folder.

// At or below this window width (the tab bar measures it), opening a sidebar with `compact` makes room for it.
const COMPACT_WIDTH = 1720;

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

// Narrows the left sidebar to its rail like workspace-chrome's button, and hides the right panel.
function makeRoom() {
  if ((shared("window.width") ?? Infinity) > COMPACT_WIDTH) return;
  const root = layout(), width = find(root, "sidebar")?.size?.px, panel = find(root, "panel");
  const made = { sidebar: width >= 160 ? width : null, panel: Boolean(panel && !panel.hidden) };
  if (made.sidebar) {
    setShared("sidebar.width", width);
    setShared("sidebar.collapsed", true);
    run("layout.resize", { id: "sidebar", px: window()?.platform === "macos" ? 76 : 44 });
  }
  if (made.panel) run("layout.hide", { id: "panel" });
  setShared("sidebar.room", made.sidebar || made.panel ? made : null);
}

// Puts back only what makeRoom collapsed, and only if it's still collapsed.
function giveBack() {
  const made = shared("sidebar.room");
  if (!made) return;
  setShared("sidebar.room", null);
  const root = layout();
  if (made.sidebar && (find(root, "sidebar")?.size?.px ?? Infinity) < 160) {
    setShared("sidebar.collapsed", false);
    run("layout.resize", { id: "sidebar", px: made.sidebar });
  }
  if (made.panel && find(root, "panel")?.hidden) run("layout.show", { id: "panel" });
}

const localId = (id) => id?.replace(/^[^/]+\//, "");

// Parking drops a terminal's herdr.tab label, so parked sidebars are remembered here.
const parkedKey = (kind, tab) => `sidebar.${kind}.${localId(tab)}`;

function sidebarTerminal(kind, tab) {
  const parked = shared(parkedKey(kind, tab));
  return terminals().find((t) => t.state === "live"
    && t.argv?.[0] === "env" && t.argv?.[1] === `HERDR_SIDEBAR=${kind}`
    && (t.labels?.["herdr.tab"] === localId(tab) || t.address === parked));
}

export function sidebarMod(kind, argv, { compact = false } = {}) {
  return class Sidebar extends View {
    init(_props, cx) {
      if (checking()) return;
      const done = () => closeOverlay(props().overlay);
      const f = focused();
      if (!f?.tab) return done();
      const term = sidebarTerminal(kind, f.tab);
      const pane = term && panes().find((p) => p.terminal === term.address);

      if (pane?.focused) {
        run("terminal.park", { terminal: term.address });
        setShared(parkedKey(kind, f.tab), term.address);
        if (compact) giveBack();
        return done();
      }
      if (pane) {
        run("pane.focus", { pane: pane.pane });
        return done();
      }
      if (compact) makeRoom();
      // Split off the tab's last pane so the sidebar lands on the right edge.
      const last = panes().filter((p) => p.tab === f.tab).at(-1);
      setShared(parkedKey(kind, f.tab), null);
      if (term) {
        if (last && !last.focused) run("pane.focus", { pane: last.pane });
        run("terminal.keep", { terminal: term.address, place: "right" });
      } else {
        run("pane.split", { direction: "right", pane: last?.pane, argv: ["env", `HERDR_SIDEBAR=${kind}`, ...argv] });
      }

      let tries = 0;
      const focusWhenShown = (cx) => {
        const t = sidebarTerminal(kind, f.tab);
        const p = t && panes().find((p) => p.terminal === t.address);
        if (p) {
          if (!p.focused) run("pane.focus", { pane: p.pane });
          return done();
        }
        if (++tries > 40) {
          notify({ title: `${kind} sidebar didn't open`, level: "error" });
          return done();
        }
        cx.timer.after(50, focusWhenShown);
      };
      cx.timer.after(0, focusWhenShown);
    }

    render() {
      return div();
    }
  };
}
