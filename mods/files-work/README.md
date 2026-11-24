# Files

Herdr's Files panel, with previews of images and PDFs as well as text, on any machine. Files on another machine are copied over to preview them.

Double-click a file, or press ↗ on its preview, to open it in a tab. The tab's **nvim** button replaces it with the file in nvim, on the machine the file is on, and **Open** opens it in its default app. Bind `files-work.nvim` in keys.json to do the same from the keyboard.

PDFs need poppler (`pdftoppm`) on this computer. Without it, macOS shows only the first page.

To use it, set the layout's files block to `"mod": "files-work"` (the workbench layout already does).
