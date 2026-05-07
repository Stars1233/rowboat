# Knowledge File Viewer — Research & Implementation Plan

## Current State

The gap is a single `<pre>` fallback in `App.tsx:4523–4527`. The decision tree today:

```
selectedPath ends in .md  →  MarkdownEditor (full ProseMirror, works great)
selectedPath is anything else  →  <pre> raw text dump  ← THIS IS THE ENTIRE GAP
```

Everything else needed already exists:

| What's needed | What exists | Where |
|---|---|---|
| Read binary files | `shell:readFileBase64` IPC handler | `apps/main/src/ipc.ts:648–667` |
| Read text files | `workspace:readFile` with `encoding` param | `packages/shared/src/ipc.ts:55–67` |
| File type detection | `attachment-presentation.ts` utilities | `renderer/src/lib/attachment-presentation.ts` |
| Audio player component | `AudioFileCard` (base64 → `<audio>`) | `renderer/src/components/ai-elements/file-path-card.tsx` |
| Image thumbnail | `SystemFileCard` (base64 → `<img>`) | Same file as above |
| Navigate to knowledge path | `onOpenKnowledgeFile` context | `renderer/src/contexts/file-card-context.tsx` |

The 10MB cap on `shell:readFileBase64` is the main constraint to watch.

---

## Recommended Architecture

### The Core Idea: `app://` Custom Protocol

**Never use `file://` for serving local content.** In Electron, `file://` has elevated same-origin privileges — an HTML file loaded that way can read other files from the filesystem.

Register a custom scheme **before `app.whenReady()`** in `apps/main/src/main.ts`:

```typescript
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true  // CRITICAL for video seeking (byte-range requests)
  }
}]);
```

Then in the handler, resolve paths inside the workspace root and block traversal:

```typescript
protocol.handle('app', (req) => {
  const filePath = resolveAndGuard(req.url, WORKSPACE_ROOT);
  if (!filePath) return new Response('Forbidden', { status: 403 });
  return net.fetch(pathToFileURL(filePath).toString());
});
```

This single protocol handles images, video, DOCX, and HTML all from one place.

---

## File Type Strategy

### Images (PNG, JPG, WEBP, GIF, SVG, AVIF)

**Approach:** Native `<img>` via `app://` protocol.

```tsx
<img src={`app://local/${encodeURIComponent(relativePath)}`} className="max-w-full" />
```

- Chromium renders all of these natively. Zero dependencies.
- HEIC/HEIF is not natively supported on Windows — use `sharp` in main process to convert to JPEG first.
- Strip EXIF before sending to LLM (GPS data). `sharp` does this automatically on JPEG output.

---

### Video (MP4, WebM, MOV)

**Approach:** Native `<video>` via `app://` protocol with `stream: true`.

```tsx
<video controls src={`app://local/${encodeURIComponent(relativePath)}`} className="w-full" />
```

`stream: true` is the only non-obvious requirement — it enables HTTP byte-range requests so scrubbing/seeking works. Without it, the entire file downloads before playback starts.

**Supported formats:** H.264/AAC in MP4, WebM (VP8/VP9/AV1). MKV partially. For WMV/AVI on Windows, fall back to "Open in system."

**Do NOT route through `shell:readFileBase64`** — 10MB cap will silently fail on real video files. The custom protocol streams directly from disk.

---

### PDF

**Approach:** Chromium's built-in PDFium renderer via `<webview>` with `plugins: true`.

```tsx
<webview
  src={`app://local/${encodeURIComponent(relativePath)}`}
  webpreferences="plugins=on,javascript=off,contextIsolation=on"
  sandbox
  style={{ width: '100%', height: '100%' }}
/>
```

Requires `webviewTag: true` in the parent BrowserWindow's `webPreferences`. Zero bundle size cost — Chromium already ships PDFium. Native zoom, scroll, print.

**Alternative if you need text extraction / annotations:** `pdfjs-dist` in a sandboxed iframe. ~35MB bundle cost, but gives you page events, text selection, and highlight APIs. Overkill unless annotation features are planned.

---

### HTML Files

**Approach:** Sandboxed `<webview>` in an isolated session partition, with **all network blocked**.

```tsx
<webview
  src={`app://local/${encodeURIComponent(relativePath)}`}
  partition="sandbox-html"
  webpreferences="contextIsolation=on,nodeIntegration=off"
  sandbox
/>
```

In `main.ts`, create the partition and block all outbound network:

```typescript
const sandboxSession = session.fromPartition('sandbox-html', { cache: false });
sandboxSession.setPermissionRequestHandler((_, __, cb) => cb(false));
sandboxSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (_, cb) =>
  cb({ cancel: true })
);
```

Relative assets (`./style.css`, `./images/photo.jpg`) served via the `app://` handler still work. External requests are silently blocked.

---

### DOCX / DOC

**Approach:** `docx-preview` for display, `mammoth.js` for LLM text extraction. They solve different problems — do not use them as alternatives.

- **`docx-preview`** — reproduces Word's visual layout in the DOM (tables, fonts, headings, images as base64). High fidelity for reading.
- **`mammoth.js`** — converts to clean semantic HTML, strips all visual formatting. For feeding document content to the model.

```typescript
// display
import { renderAsync } from 'docx-preview';
const buffer = await window.api.readFileBytes(filePath); // needs new IPC handler
await renderAsync(buffer, containerElement);

// LLM extraction
import mammoth from 'mammoth';
const { value: html } = await mammoth.convertToHtml({ arrayBuffer: buffer });
```

A new `read-file-bytes` IPC handler is needed in `main/src/ipc.ts` that returns a raw `Uint8Array` — the existing `shell:readFileBase64` returns a base64 string which would need decoding.

---

## Split-Pane Layout

**Recommended library: `react-resizable-panels`** (Brian Vaughn, React core team alum). Powers `shadcn/ui`'s `<Resizable>` component. Used in production by OpenAI and Adobe.

```tsx
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

<PanelGroup direction="horizontal" autoSaveId="knowledge-chat-layout">
  <Panel defaultSize={55} minSize={30}>
    <FileViewer path={selectedPath} />
  </Panel>
  <PanelResizeHandle className="w-1.5 bg-border hover:bg-primary/50 transition-colors" />
  <Panel defaultSize={45} minSize={25}>
    <ChatView />
  </Panel>
</PanelGroup>
```

`autoSaveId` persists the split ratio to `localStorage` automatically across sessions.

**Alternative: `allotment`** — extracted directly from VS Code's C++ split-view code. Pixel-identical to VS Code. Slightly less React-idiomatic API.

---

## Security Model

| Concern | Pattern |
|---|---|
| Local file access | Main process only via `ipcMain.handle`. Renderer never reads filesystem directly. |
| Protocol | Custom `app://` scheme, not `file://`. All local resources routed through validated handler. |
| Path traversal | Every path resolved to absolute, checked with `startsWith(WORKSPACE_ROOT)`. |
| Renderer isolation | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. |
| Untrusted HTML | Separate `session.fromPartition('sandbox-html')` with network blocked. |

---

## Implementation Steps

### Step 1 — Register `app://` protocol in `main.ts`
Before `app.whenReady()`. One change, covers images, video, PDF, and HTML.

### Step 2 — Add `read-file-bytes` IPC handler in `ipc.ts`
Returns raw `Uint8Array` for DOCX rendering. Avoids base64 encode/decode overhead for large files.

### Step 3 — Create `KnowledgeFileViewer` component
`apps/x/apps/renderer/src/components/knowledge-file-viewer.tsx`

Extension routing:

| Extensions | Renderer |
|---|---|
| `.png .jpg .jpeg .webp .gif .svg .avif` | `<img>` via `app://` |
| `.mp4 .mov .webm` | `<video>` via `app://` |
| `.pdf` | `<webview plugins sandbox>` |
| `.html .htm` | `<webview partition="sandbox-html">` |
| `.docx .doc` | `docx-preview` in sandboxed iframe |
| `.mp3 .wav .m4a` | Reuse existing `AudioFileCard` |
| everything else | "Open in system" button (`shell.openPath`) |

### Step 4 — Replace `<pre>` fallback in `App.tsx:4522–4527`
One-line swap. All routing logic lives in `KnowledgeFileViewer`.

### Step 5 — Add split-pane layout
Install `react-resizable-panels`, wrap knowledge view (file viewer + chat) in `PanelGroup`.

---

## Dependencies to Add

| Package | Purpose | Bundle cost |
|---|---|---|
| `react-resizable-panels` | Split pane layout | ~15KB |
| `docx-preview` | DOCX visual rendering | ~500KB |
| `mammoth` | DOCX → semantic HTML for LLM | ~300KB |
| `pdfjs-dist` | PDF with text extraction (optional) | ~35MB — only if PDFium isn't enough |

Images, video, PDF (via PDFium), and HTML have zero additional dependencies.

---

## What to Avoid

- **`<iframe src="file:///...">` for anything** — always use `app://`.
- **Routing large files through `shell:readFileBase64`** — 10MB cap silently fails.
- **Using `mammoth` for display** — it strips all formatting. LLM extraction only.
- **Assuming `webviewTag` is enabled** — check `main.ts` BrowserWindow creation before shipping PDF/HTML webviews.
