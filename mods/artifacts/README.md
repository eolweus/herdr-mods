# Artifacts

Three tabs of cards with screenshots: apps on every machine with an on/off switch and a link for Chrome, Claude artifacts (pinned claude.ai links and HTML your sessions wrote), and Discover: what's listening, with Claude working out how to start it.

- **Apps** are saved in `~/.config/herdr-app/apps.json` (`apps` and `links`). Each runs in its own hc terminal named `app-<id>-<port>` on its machine, through the login shell, with `$PORT` set: the app's fixed port, or a free one.
- **Discover** lists this user's TCP listeners on ports >= 1024 on every machine. "Save as app" runs `claude -p` there with read-only tools to work out the folder, start command and port, then opens the editor to confirm.
- **Claude artifacts**: pinned links, plus HTML files sessions wrote (`Write` calls in `~/.claude/projects` transcripts from the last 30 days), one row per folder. Files on this Mac open directly; on another machine the folder is served with `python3 -m http.server` (`html-<hash>-<port>`).

Links open in Google Chrome. Remote apps open as `http://<machine>:<port>`, so they must listen on 0.0.0.0.
- **Screenshots** come from headless Chrome (own profile in `data/artifacts/chrome`) into `data/artifacts/shots`, one at a time: running apps once per run, reachable discovered servers and local HTML when there's no picture yet. The camera button retakes one.
- A remote app that only listens on its machine's localhost opens through an ssh tunnel (`tunnel-<machine>-<local>-<remote>`) as `http://localhost:<port>`.
