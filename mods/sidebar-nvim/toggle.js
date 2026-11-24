import { View, div } from "gpui-kit";
import { checking, closeOverlay, focused, notify, panes, props, run, setShared, shared, terminals } from "herdr";

// Shared by every sidebar-* mod as a hard link: mods can't import outside their own folder.

const localId = (id) => id?.replace(/^[^/]+\//, "");

// Parking drops a terminal's herdr.tab label, so parked sidebars are remembered here.
const parkedKey = (kind, tab) => `sidebar.${kind}.${localId(tab)}`;

function sidebarTerminal(kind, tab) {
  const parked = shared(parkedKey(kind, tab));
  return terminals().find((t) => t.state === "live"
    && t.argv?.[0] === "env" && t.argv?.[1] === `HERDR_SIDEBAR=${kind}`
    && (t.labels?.["herdr.tab"] === localId(tab) || t.address === parked));
}

export function sidebarMod(kind, argv) {
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
        return done();
      }
      if (pane) {
        run("pane.focus", { pane: pane.pane });
        return done();
      }
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
