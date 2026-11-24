# Artifacts

Apps on every machine with an on/off switch and a link for Chrome, a Discover list of what's listening (Claude works out how to start it), and Claude artifacts: pinned claude.ai links and HTML your sessions wrote.

- **Apps** are saved in `~/.config/herdr-app/apps.json` (`apps` and `links`). Each runs in its own hc terminal named `app-<id>-<port>` on its machine, through the login shell, with `$PORT` set: the app's fixed port, or a free one.
- **Discover** lists this user's TCP listeners on ports >= 1024 on every machine. "Save as app" runs `claude -p` there with read-only tools to work out the folder, start command and port, then opens the editor to confirm.
- **Claude artifacts**: pinned links, plus HTML files sessions wrote (`Write` calls in `~/.claude/projects` transcripts from the last 30 days), one row per folder. Files on this Mac open directly; on another machine the folder is served with `python3 -m http.server` (`html-<hash>-<port>`).

Links open in Google Chrome. Remote apps open as `http://<machine>:<port>`, so they must listen on 0.0.0.0.
