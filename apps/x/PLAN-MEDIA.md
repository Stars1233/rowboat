# Media File Rendering — Implementation Plan

## Goal
Render PDFs, images, and videos in the knowledge view, alongside the existing HTML viewer.

## Foundation
All three file types are served through a single custom `app://` protocol registered in the Electron main process. This avoids `file://` (elevated privileges in Electron) and supports byte-range streaming (needed for video seeking).

---

## Phase 1 — Register `app://` custom protocol

### What
Main-process protocol handler that serves any workspace-relative file with path traversal guard.

### Work
1. In `apps/main/src/main.ts`, before `app.whenReady()`:
   - `protocol.registerSchemesAsPrivileged` for `app` with `{ standard: true, secure: true, supportFetchAPI: true, stream: true }`
2. After `app.whenReady()`:
   - `protocol.handle('app', ...)` — parses URL, decodes path, resolves against workspace root using the existing `resolveWorkspacePath`, returns `net.fetch(pathToFileURL(absPath))`
   - On invalid/outside-workspace path: return 403

### Test ✅
- DevTools: `fetch('app://local/knowledge/<known-file>').then(r => r.status)` → 200
- DevTools: `fetch('app://local/../../etc/passwd')` → 403
- Verify response includes correct mime type for known extensions

---

## Phase 2 — Image renderer

### What
`ImageFileViewer` component renders supported images via `<img src="app://local/<path>">`.

### Work
1. New file `apps/renderer/src/components/image-file-viewer.tsx`
2. Detects: `.png .jpg .jpeg .webp .gif .svg .avif .bmp .ico`
3. Centered, object-contain layout, dark/light bg
4. HEIC/HEIF (or any other unsupported decode failure) → fall back to "Open in system" via `shell:openPath`
5. Loading state and error state mirroring HtmlFileViewer
6. Wire into `App.tsx` render switch before the `<pre>` fallback

### Test ✅
- Open `.png`, `.jpg`, `.svg`, `.webp` files → renders correctly
- Open a `.heic` file (or rename a non-image to `.png` to force decode failure) → shows fallback
- Switch between image files rapidly → no stale image, no flicker

---

## Phase 3 — Video renderer

### What
`VideoFileViewer` component using native `<video>` tag.

### Work
1. New file `apps/renderer/src/components/video-file-viewer.tsx`
2. Detects: `.mp4 .mov .webm .m4v`
3. `<video controls src="app://local/<path>" />` — full width, max height
4. Loading and error states
5. Wire into `App.tsx` render switch

### Test ✅
- Open a 50MB+ MP4 → starts playing, scrubber works, can seek to middle without re-downloading
- Verify byte-range requests in DevTools Network tab (Range header on requests)
- Switch away mid-playback → video stops cleanly, no leaked audio

---

## Phase 4 — PDF renderer

### What
`PdfFileViewer` using Chromium's built-in PDFium via `<iframe src="app://local/<path>">`.

### Work
1. New file `apps/renderer/src/components/pdf-file-viewer.tsx`
2. Detects: `.pdf`
3. `<iframe src="app://local/<path>" className="w-full h-full" />` — Chromium auto-detects PDF mime type and uses PDFium plugin
4. Confirm `webPreferences.plugins: true` is set on the BrowserWindow (required for PDFium to activate)
5. Wire into `App.tsx` render switch

### Test ✅
- Open multi-page PDF → renders with native zoom/scroll/print toolbar
- Open password-protected PDF → Chromium prompts for password (built-in)
- Switch between PDFs → no stale content

---

## Out of scope for this branch
- DOCX rendering (requires `docx-preview` library — separate PR)
- Split-pane resizable layout
- Audio (the existing `AudioFileCard` is reused if needed)
- Annotation/highlighting on PDFs (would require `pdfjs-dist`)
- Iframe persistence cache for HTML viewer (separate optimization)
