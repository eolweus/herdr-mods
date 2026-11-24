import { div, image } from "gpui-kit";
import { v_flex, Editor, EditorState } from "gpui-base";
import { appHome, exec, readTextFile, settings, theme, window } from "herdr";
import * as fs from "fs/promises";
import { Buffer } from "buffer";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg", "ico"]);
const MAX = 100 * 1024 * 1024;
// Herdr started from the Dock doesn't have Homebrew on its PATH.
const PATH = 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; ';
const CACHE = "data/files-work/cache";
let made = 0;

export const extOf = (path) => {
  const name = path.split("/").pop();
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
};

export function pruneCache() {
  exec("find", [`${appHome()}/${CACHE}`, "-mindepth", "1", "-maxdepth", "1", "-mtime", "+0", "-exec", "rm", "-rf", "{}", "+"]).catch(() => {});
}

export class Preview {
  constructor(path, on, cx, line = null) {
    this.path = path;
    this.line = line;
    this.on = on ?? null;
    const ext = extOf(path);
    this.kind = IMAGE.has(ext) ? "image" : ext === "pdf" ? "pdf" : "text";
    // image() takes paths under appHome(), so even local images are copied there.
    this.rel = `${CACHE}/${Date.now().toString(36)}-${made++}`;
    this.dir = `${appHome()}/${this.rel}`;
    this.zoom = 1;
    this.width = 0;
    cx.spawn(async (cx) => {
      try {
        if (this.kind === "text") await this.loadText();
        else if (this.kind === "image") this.image = await this.cached();
        else await this.renderPdf(await this.local(), cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      if (!this.released) cx.notify();
    });
  }

  release() {
    this.released = true;
    this.code?.release();
    this.code = null;
    exec("rm", ["-rf", this.dir]).catch(() => {});
  }

  async loadText() {
    let text;
    try { text = await readTextFile(this.path, { on: this.on }); }
    catch { this.kind = "other"; return; }
    if (text === null) throw new Error("This file is no longer there");
    if (text.includes("\0")) { this.kind = "other"; return; }
    const t = theme(), ext = extOf(this.path) || "txt";
    this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
      value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    if (this.line > 1) {
      const lines = text.split("\n").slice(0, this.line);
      const start = lines.slice(0, -1).join("\n").length + 1;
      this.code.set_selected_range({ start, end: start + (lines[lines.length - 1]?.length ?? 0) });
      this.jump = true;
    }
  }

  async cached() {
    const name = this.path.split("/").pop();
    if (this.on) await this.local();
    else {
      await exec("mkdir", ["-p", this.dir]);
      const r = await exec("cp", [this.path, `${this.dir}/${name}`]);
      if (r.code !== 0) throw new Error(r.stderr || "Couldn't read the file");
    }
    return `${this.rel}/${name}`;
  }

  // Images and PDFs are drawn here, so a file on another machine is copied over first.
  async local() {
    if (!this.on) return this.path;
    if (this.copy) return this.copy;
    this.copying = true;
    const r = await exec("sh", ["-c", `test -r "$1" || exit 3; [ "$(wc -c < "$1")" -le ${MAX} ] || exit 4; base64 < "$1"`, "sh", this.path], { on: this.on, timeout: 120000 });
    if (r.code === 3) throw new Error("This file is no longer there");
    if (r.code === 4) throw new Error("Too large to copy here (over 100 MB)");
    if (r.code !== 0) throw new Error(r.stderr || "Couldn't copy the file");
    const file = `${this.dir}/${this.path.split("/").pop()}`;
    await exec("mkdir", ["-p", this.dir]);
    await fs.writeFile(file, Buffer.from(r.stdout, "base64"));
    this.copying = false;
    return (this.copy = file);
  }

  // The first pages come first, so a long PDF shows something while the rest renders.
  async renderPdf(file, cx) {
    const out = `${this.dir}/pages`;
    const script = PATH + `mkdir -p "$2" || exit 1
if command -v pdftoppm >/dev/null; then
  pdfinfo -f 1 -l 300 "$1" 2>/dev/null | sed -n 's/^Page *[0-9]* size: *\\([0-9.]*\\) x \\([0-9.]*\\).*/\\1 \\2/p'
  echo --
  pdftoppm -r 130 -png -f "$3" -l "$4" "$1" "$2/p" || exit 2
elif command -v sips >/dev/null; then
  echo one; echo --
  sips -s format png "$1" --out "$2/p-1.png" >/dev/null || exit 2
else exit 5; fi
ls "$2"`;
    let sizes = [];
    for (const [from, to] of [[1, 2], [3, 300]]) {
      const r = await exec("sh", ["-c", script, "sh", file, out, String(from), String(to)], { timeout: 180000 });
      if (r.code === 5) throw new Error("Install poppler (pdftoppm) to preview PDFs");
      if (r.code !== 0 && from === 1) throw new Error(r.stderr || "Couldn't render this PDF");
      const [head, list = ""] = r.stdout.split("--\n");
      if (head.trim() === "one") this.onePage = true;
      else if (from === 1) sizes = head.trim().split("\n").map((l) => l.split(" ").map(Number));
      this.pages = list.trim().split("\n").filter((n) => n.endsWith(".png")).map((n, i) => ({
        path: `${this.rel}/pages/${n}`,
        aspect: sizes[i]?.[0] ? sizes[i][1] / sizes[i][0] : 1.294,
      }));
      if (this.released || this.onePage || (sizes.length && sizes.length <= 2)) return;
      cx.notify();
    }
    if (sizes.length > 300) this.truncated = true;
  }

  async openOutside() {
    const file = await this.local();
    await exec(window()?.platform === "macos" ? "open" : "xdg-open", [file]);
  }

  body(t) {
    const note = (text) => div().p(12).text_size(12).text_color(t.dim).child(text);
    if (this.error) return note(this.error);
    if (this.kind === "text") {
      if (!this.code) return note("Loading file…");
      const font = settings();
      return Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0);
    }
    if (this.kind === "other") return note("No preview for this kind of file");
    if (this.copying) return note(`Copying from ${this.on}…`);
    if (this.kind === "image") return this.image ? div().flex_1().min_h(0).p(12).child(image(this.image).size_full()) : note("Loading image…");
    if (!this.pages?.length) return note("Rendering PDF…");
    const w = Math.max(120, Math.min((this.width || 520) - 28, 900) * this.zoom);
    return v_flex().id("pdf-pages").flex_1().min_h(0).overflow_scrollbar().p(14).gap(10).items_center().bg(t.hover)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 2) { this.width = size.width; cx.notify(); }
      })
      .children(this.pages.map((p) => image(p.path).w(w).h(w * p.aspect).flex_none()))
      .when(Boolean(this.onePage), (el) => el.child(note("Only the first page: install poppler (pdftoppm) for the rest")))
      .when(Boolean(this.truncated), (el) => el.child(note("Showing the first 300 pages")));
  }
}
