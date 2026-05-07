# HTML File Rendering — Implementation Plan

## Goal
Replace the `<pre>` raw text fallback in the knowledge view with a proper HTML file renderer using `<iframe srcdoc sandbox="allow-scripts">`.

## Scope
- Only HTML file rendering for now
- No layout changes, no split pane
- No other file types in this PR

---

## Phase 1 — IPC: Read HTML file content and pass to renderer

### What
Add an IPC handler in the main process that reads a local HTML file and returns its content as a string to the renderer.

### Work
1. Add `knowledge:readHtmlFile` handler in `apps/main/src/ipc.ts`
   - Accepts a workspace-relative path
   - Resolves to absolute path, validates it stays inside workspace root (path traversal guard)
   - Reads file as UTF-8 string
   - Returns the HTML string to renderer
2. Add the channel type to `packages/shared/src/ipc.ts`

### Test ✅
- Open a `.html` file from the knowledge tree
- Console log the returned string in the renderer
- Verify: correct HTML content is returned, no errors
- Verify: attempting a path like `../../secret.txt` is rejected with an error

---

## Phase 2 — Renderer: Detect `.html` files and render in iframe

### What
In `App.tsx`, detect when `selectedPath` is an `.html` file and render it in a sandboxed `<iframe srcdoc>` instead of the `<pre>` fallback.

### Work
1. In the file loading logic (`App.tsx:1284–1357`), when extension is `.html`:
   - Call `knowledge:readHtmlFile` via IPC
   - Store the HTML string in state
2. In the knowledge view render switch (`App.tsx:4522–4527`):
   - Add a condition: if extension is `.html` → render `<HtmlFileViewer html={htmlContent} />`
   - Otherwise fall through to existing `<pre>` fallback
3. Create `apps/renderer/src/components/html-file-viewer.tsx`:
   - Accepts `html: string` prop
   - Renders `<iframe srcdoc={html} sandbox="allow-scripts" />` with full width/height, no border

### Test ✅
- Open a real `.html` file from the knowledge tree
- Verify: file renders visually in the iframe (not raw text)
- Verify: a non-html file still shows the `<pre>` fallback (no regression)
- Verify: an HTML file with a `<script>` tag runs its JS (allow-scripts works)
- Verify: an HTML file with `<script src="https://evil.com">` — open network tab, confirm no request is made (allow-same-origin is absent, so external scripts are blocked by default CSP)

---

## Phase 3 — Polish: Loading state, error state, empty file handling

### What
Handle edge cases so the viewer never shows a broken or confusing UI.

### Work
1. Loading state — show a spinner while the IPC call is in flight
2. Error state — if `knowledge:readHtmlFile` throws (file deleted, permission error), show a clean error message with the file path
3. Empty file — if HTML string is empty, show "This file is empty" instead of a blank iframe
4. Large files — if file is over a reasonable size limit (e.g. 5MB), show "File too large to preview — Open in system" button that calls `shell.openPath`

### Test ✅
- Open a valid HTML file → renders correctly
- Delete the file while it's open, trigger a reload → error state shown cleanly
- Open an empty `.html` file → "This file is empty" message shown
- Simulate a file over 5MB → "File too large" message with open button shown
- Verify: no console errors in any of the above scenarios

---

## Out of scope for this PR
- PDF, DOCX, image, video rendering
- Split pane / resizable layout
- Relative asset loading (`./style.css`) — Phase 2 uses `srcdoc` which has no base URL; assets will not load. Acceptable for now, documented as known limitation.
- `app://` custom protocol — not needed until we handle relative assets
