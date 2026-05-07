# Tracks

> Frontmatter directives that keep a markdown note's body auto-updated — on a schedule, when a relevant event arrives, or on demand.

A track is a single entry in a note's YAML frontmatter under the `track:` array. Each entry defines an instruction, optional triggers (cron / window / once / event — any mix), and (after the first run) some runtime state. When a trigger fires, a background agent edits the **note body** to satisfy the instruction. A note with no `track:` key is just a static note.

**Example** (a note that shows the current Chicago time, refreshed hourly):

~~~markdown
---
track:
  - id: chicago-time
    instruction: |
      Show the current time in Chicago, IL in 12-hour format.
    active: true
    triggers:
      - type: cron
        expression: "0 * * * *"
    lastRunAt: "2026-05-07T15:00:01.234Z"
    lastRunId: "..."
    lastRunSummary: "Updated — 3:00 PM, Central Time."
---

# Chicago time

3:00 PM, Central Time
~~~

## Table of Contents

1. [Product Overview](#product-overview)
2. [Architecture at a Glance](#architecture-at-a-glance)
3. [Technical Flows](#technical-flows)
4. [Schema Reference](#schema-reference)
5. [Section Placement](#section-placement)
6. [Daily-Note Template & Migrations](#daily-note-template--migrations)
7. [Renderer UI](#renderer-ui)
8. [Prompts Catalog](#prompts-catalog)
9. [File Map](#file-map)

---

## Product Overview

### Triggers

A track has zero or more triggers under a single `triggers:` array. Each trigger is one of four types and can be mixed freely:

| Type | When it fires | Shape |
|---|---|---|
| **`cron`** | At exact cron times | `{ type: cron, expression: "0 * * * *" }` |
| **`window`** | Once per day, anywhere inside a time-of-day band | `{ type: window, startTime: "09:00", endTime: "12:00" }` |
| **`once`** | Once at a future time, then never | `{ type: once, runAt: "2026-04-14T09:00:00" }` |
| **`event`** | When a matching event arrives (e.g. new Gmail thread) | `{ type: event, matchCriteria: "Emails about Q3 planning" }` |

A track with no `triggers` (or an empty array) is **manual-only** — fires only when the user clicks Run in the sidebar.

`cron` and `once` enforce a 2-minute grace window — if the scheduled time passed more than 2 minutes ago (e.g. the app was offline), the run is skipped, not replayed. `window` is forgiving by design: as long as it's still inside the band and the day's cycle hasn't fired yet, it fires the moment the app is open. The day's cycle is anchored at `startTime`.

A single track can carry multiple triggers. The flagship example is in Today.md's `priorities` track: three `window` entries (morning / midday / post-lunch) plus two `event` entries (gmail / calendar) — five triggers total, giving a baseline rebuild three times per day plus reactive updates on incoming signals.

### Creating a track

Two paths, both producing identical on-disk YAML:

1. **Hand-written** — type the entry directly into a note's frontmatter under `track:`. The scheduler picks it up on its next 15-second tick.
2. **Sidebar chat** — mention a note (or have it attached) and ask Copilot for something dynamic. Copilot is tuned to recognize a wide range of phrasings beyond the literal word "track" (see "Prompts Catalog → Copilot trigger paragraph" for the signal taxonomy); it loads the `tracks` skill, edits the note's frontmatter via `workspace-edit`, then **runs the track once by default** so the user immediately sees content. The auto-run is skipped only when the user explicitly says not to run yet.

There is no inline-block creation flow anymore. The Cmd+K palette is search-only and does not invoke Copilot.

### Viewing and managing tracks

The editor has a Radio-icon button in the top toolbar (right side) that opens the **Track Sidebar** for the current note. The sidebar:

- **List view** — one row per track in the note's frontmatter. Title is the track's `id`; subtitle is the trigger summary plus a `Paused ·` prefix when applicable, plus the instruction's first line as a tertiary line. A Play button on the right runs that track.
- **Detail view** (click a row) — back arrow + tabs (*What* / *Schedule* / *Events* / *Details*), an advanced raw-YAML editor, danger-zone delete, and a footer with "Edit with Copilot" + "Run now".
- **Status hook** — `useTrackStatus` subscribes to `tracks:events` IPC; rows show a spinner whenever a track is running, regardless of hover state.

Every mutation in the sidebar goes through IPC to the backend — the renderer never writes the file itself. This avoids races with the scheduler/runner writing runtime fields like `lastRunAt`.

### What the runtime agent does

When a trigger fires, a background agent ("track-run") receives a short message:
- The track's `id`, the workspace-relative path to the note, and a localized timestamp.
- The instruction.
- For event runs only: the matching `eventMatchCriteria` text and the event payload, with a Pass-2 decision directive ("only edit if the event genuinely warrants it").

The agent's system prompt tells it to:
1. Call `workspace-readFile` to read the current note (the body may be long; no body snapshot is passed in the message — fetch fresh).
2. Find or create the H2 section the instruction names (placement model below).
3. Update only that section's content. Never modify YAML frontmatter — that's owned by the user and the runtime.
4. After writing, re-check its section's position; cut-and-paste only its own block if it's misplaced (handles the cold-start firing-order problem).
5. End with a one-line summary stored as `lastRunSummary`.

The agent has the full workspace toolkit (read/edit/grep/web-search/browser/MCP) — there's no special "track-content" tool anymore; tracks just ship general edits.

---

## Architecture at a Glance

```
Editor toolbar Radio button ─click──► TrackSidebar (React)
                                            │
                                            ├──► IPC: track:get / update /
                                            │        replaceYaml / delete / run
                                            │
Backend (main process)
  ├─ Scheduler loop  (15 s) ──┐
  ├─ Event processor (5 s)  ──┼──► triggerTrackUpdate() ──► track-run agent
  └─ Builtin tool  run-track ─┘                                     │
                                                                    ▼
                                                  workspace-readFile / -edit
                                                                    │
                                                                    ▼
                                                  body region rewritten on disk
                                                  frontmatter lastRun* patched
```

**Single-writer invariant** — the renderer is never a file writer for the `track:` key. All on-disk changes go through backend helpers in `packages/core/src/knowledge/track/fileops.ts` (`updateTrack`, `replaceTrackYaml`, `deleteTrack`). `extractAllFrontmatterValues` in the renderer's frontmatter helper explicitly skips the `track:` key (and `buildFrontmatter` splices it back from the original raw on save), so the FrontmatterProperties UI can't accidentally mangle it.

**Event contract** — `window.dispatchEvent(CustomEvent('rowboat:open-track-sidebar', { detail: { filePath } }))` is the sole entry point from editor toolbar → sidebar. `rowboat:open-copilot-edit-track` opens the Copilot sidebar with the note attached.

---

## Technical Flows

### Scheduling (cron / window / once)

- **Module**: `packages/core/src/knowledge/track/scheduler.ts`. Polls every **15 seconds** (`POLL_INTERVAL_MS`).
- Each tick: `workspace.readdir('knowledge', { recursive: true })`, filter `.md`, iterate all tracks via `fetchAll(relPath)`.
- For each track with `active === true` and at least one timed trigger (`cron` / `window` / `once`), `find` the first due trigger via `isTriggerDue(t, lastRunAt)` (`schedule-utils.ts`).
- When due, fire `triggerTrackUpdate(track.id, relPath, undefined, 'timed')` (fire-and-forget; the runner's concurrency guard prevents duplicates).
- **Grace window** — `cron` and `once` enforce a 2-minute grace; missed schedules are skipped, not replayed. `window` has no grace — anywhere inside the band counts.
- **Window cycle anchor** — a window's daily cycle starts at `startTime`. Once a fire lands strictly after today's `startTime`, that window is done for the day. The strict comparison handles the boundary case (e.g. an 08:00–12:00 + a 12:00–15:00 window each get to fire even when the morning fire happens exactly at 12:00:00).
- **Startup** — `initTrackScheduler()` is called in `apps/main/src/main.ts` at app-ready, alongside `initTrackEventProcessor()`.

### Event pipeline

**Producers** — any data source that should feed tracks emits events:
- **Gmail** (`packages/core/src/knowledge/sync_gmail.ts`) — call sites after a successful thread sync invoke `createEvent({ source: 'gmail', type: 'email.synced', payload: <thread markdown> })`.
- **Calendar** (`packages/core/src/knowledge/sync_calendar.ts`) — one bundled event per sync, with a markdown digest payload built by `summarizeCalendarSync()`.

**Storage** — `packages/core/src/knowledge/track/events.ts` writes each event as a JSON file under `~/.rowboat/events/pending/<id>.json`. IDs come from the DI-resolved `IdGen` (ISO-based, lexicographically sortable) — so `readdirSync(...).sort()` is strict FIFO.

**Consumer loop** — same file, `init()` polls every **5 seconds**, then `processPendingEvents()` walks sorted filenames. For each event:
1. Parse via `KnowledgeEventSchema`; malformed files go to `done/` with `error` set (the loop stays alive).
2. `listAllTracks()` scans every `.md` under `knowledge/`. Only tracks with at least one `event`-type trigger appear in the routing list; their `eventMatchCriteria` is the joined `matchCriteria` from all event triggers (`'; '`-separated).
3. `findCandidates(event, allTracks)` runs Pass 1 LLM routing (below).
4. For each candidate, `triggerTrackUpdate(id, filePath, event.payload, 'event')` **sequentially** — preserves total ordering within the event.
5. Enrich the event JSON with `processedAt`, `candidates`, `runIds`, `error?`, then move to `events/done/<id>.json`.

**Pass 1 routing** (`routing.ts`):
- **Short-circuit** — if `event.targetTrackId` + `event.targetFilePath` are set (manual re-run events), skip the LLM and return that track directly.
- Filter to `active && instruction && eventMatchCriteria` tracks.
- Batches of `BATCH_SIZE = 20`.
- Per batch, `generateObject()` with `ROUTING_SYSTEM_PROMPT` + `buildRoutingPrompt()` and `Pass1OutputSchema` → `candidates: { trackId, filePath }[]`. The composite key `trackId::filePath` deduplicates across files since `id` is only unique per file.

**Pass 2 decision** happens inside the track-run agent (see Run flow) — Pass 1 is liberal, the agent vetoes false positives before touching the body.

### Run flow (`triggerTrackUpdate`)

Module: `packages/core/src/knowledge/track/runner.ts`.

1. **Concurrency guard** — static `runningTracks: Set<string>` keyed by `${id}:${filePath}`. Duplicate calls return `{ action: 'no_update', error: 'Already running' }`.
2. **Fetch track** via `fetchAll(filePath)`, locate by `id`.
3. **Snapshot body** via `readNoteBody(filePath)` for the post-run diff.
4. **Create agent run** — `createRun({ agentId: 'track-run' })`.
5. **Set `lastRunAt` + `lastRunId` immediately** (before the agent executes). Prevents retry storms: if the run fails, the scheduler's next tick won't re-trigger; for `once` tracks the "done" marker is already set.
6. **Emit `track_run_start`** on the `trackBus` with the trigger type (`manual` / `timed` / `event`).
7. **Send agent message** built by `buildMessage(filePath, track, trigger, context?)` (see Prompts Catalog #4). The path is converted to its workspace-relative form (`knowledge/${filePath}`) so the agent's tools resolve correctly.
8. **Wait for completion** — `waitForRunCompletion(runId)`, then `extractAgentResponse(runId)` for the summary.
9. **Compare body**: re-read body via `readNoteBody(filePath)`, diff vs the snapshot. If changed → `action: 'replace'`; else → `action: 'no_update'`.
10. **Patch `lastRunSummary`** via `updateTrack(filePath, id, { lastRunSummary })`.
11. **Emit `track_run_complete`** with `summary` or `error`.
12. **Cleanup**: `runningTracks.delete(key)` in a `finally` block.

Returned to callers: `{ trackId, runId, action, contentBefore, contentAfter, summary, error? }`.

### IPC surface

| Channel | Caller → handler | Purpose |
|---|---|---|
| `track:run` | Renderer (sidebar Run button) | Fires `triggerTrackUpdate(..., 'manual')` |
| `track:get` | Sidebar on detail open | Returns fresh per-track YAML from disk via `fetchYaml(filePath, id)` |
| `track:update` | Sidebar toggle / partial edits | `updateTrack` merges a partial into the on-disk entry |
| `track:replaceYaml` | Sidebar advanced raw-YAML save | `replaceTrackYaml` validates + writes the full entry |
| `track:delete` | Sidebar danger-zone confirm | `deleteTrack` removes the entry from the `track:` array |
| `track:setNoteActive` | Background-agents view toggle | Flips `active` on every track in a note |
| `track:listNotes` | Background-agents view load | Lists all notes that contain at least one track, with summary fields |
| `tracks:events` | Server → renderer (`webContents.send`) | Forwards `trackBus` events to `useTrackStatus` |

Request/response schemas live in `packages/shared/src/ipc.ts`; handlers in `apps/main/src/ipc.ts`; backend helpers in `packages/core/src/knowledge/track/fileops.ts`.

### Concurrency & FIFO guarantees

- **Per-track serialization** — the `runningTracks` guard in `runner.ts`. A track is at most running once at a time; overlapping triggers (manual + scheduled + event) return `error: 'Already running'`.
- **Backend is single writer for `track:`** — all editing goes through fileops; the renderer's FrontmatterProperties UI explicitly preserves `track:` byte-for-byte across saves.
- **File lock** — every fileops mutation runs under `withFileLock(absPath)` so the runner, scheduler, and IPC handlers serialize on the file.
- **Event FIFO** — monotonic `IdGen` IDs → lexicographic filenames → `sort()` in `processPendingEvents()`. Candidates within one event are processed sequentially.
- **No retry storms** — `lastRunAt` is set at the *start* of a run, not the end. A crash mid-run leaves the track marked as ran; the scheduler's next tick computes the next occurrence from that point.

---

## Schema Reference

All canonical schemas live in `packages/shared/src/track.ts`:

- `TrackSchema` — a single entry in the frontmatter `track:` array. Fields: `id` (kebab-case, unique within the note), `instruction`, `active` (default true), `triggers?`, `model?`, `provider?`, `icon?`. **Runtime-managed (never hand-write):** `lastRunAt`, `lastRunId`, `lastRunSummary`.
- `TriggerSchema` — discriminated union over `{ type: 'cron' | 'window' | 'once' | 'event' }`. Window has just `startTime` + `endTime` (no `cron` field — the cycle is anchored at `startTime`).
- `KnowledgeEventSchema` — the on-disk shape of each event JSON in `events/pending/` and `events/done/`. Enrichment fields (`processedAt`, `candidates`, `runIds`, `error`) are populated when moving to `done/`.
- `Pass1OutputSchema` — the structured response the routing classifier returns: `{ candidates: { trackId, filePath }[] }`.

The skill's Canonical Schema block is auto-generated at module load — `stringifyYaml(z.toJSONSchema(TrackSchema))` — so editing `TrackSchema` propagates to the skill on the next build.

---

## Section Placement

Tracks no longer have formal target regions. Each instruction names a section by H2 heading (e.g. *"in a section titled 'Overview' at the top"*) and the agent finds or creates that section.

The contract (defined in the run-agent system prompt — `packages/core/src/knowledge/track/run-agent.ts`):

- Sections are **H2 headings** (`## Section Name`). Match by exact heading text.
- **Existing**: replace its content (everything between that heading and the next H2 — or end of file). Heading itself stays.
- **Missing**: create it. The placement hint determines location:
  - "at the top" → just below the H1 title.
  - "after X" → immediately after section X.
  - no hint → append.
- **Self-heal**: after writing, the agent re-checks its section's position. If misplaced (the cold-start case where empty notes get sections in firing order rather than reading order), the agent moves only its **own** H2 block — never reorders other tracks' sections.
- **Boundaries**: never modify another track's section content; never duplicate; never touch frontmatter; if the user renamed the heading, recreate per the placement hint.

This keeps tracks loosely coupled: each one stakes out a section by name, and the rest of the body is entirely the user's.

---

## Daily-Note Template & Migrations

`Today.md` is the canonical demo of what tracks can do. It ships with six tracks (overview/photo combined into one, calendar, emails, what-you-missed, priorities) showing pure-cron, pure-event, multi-window, and multi-trigger configurations.

**Versioning** — `packages/core/src/knowledge/ensure_daily_note.ts` carries a `CANONICAL_DAILY_NOTE_VERSION` constant and a `templateVersion` scalar in the frontmatter. On app start, `ensureDailyNote()`:

- File missing → fresh write at canonical version.
- File at-or-above canonical → no-op.
- File below canonical → rename existing to `Today.md.bkp.<ISO-stamp>` (which doesn't end in `.md`, so the scheduler/event router skip it), then write the canonical template with the body byte-preserved via `splitFrontmatter` from `application/lib/parse-frontmatter.ts`.

Any change to the canonical TRACKS list, instructions, default body, or trigger config should bump the constant. Existing users will get the new template on next launch with their body sections preserved; their `lastRunAt` and any custom additions to the tracks list are dropped (the .bkp file is the recovery path).

---

## Renderer UI

The chip-in-editor model is gone. Replacements:

- **Toolbar button** — `apps/renderer/src/components/editor-toolbar.tsx`. A Radio-icon ghost button at the top-right of the editor toolbar. `markdown-editor.tsx` passes `onOpenTracks` (only when a `notePath` is available) which dispatches `rowboat:open-track-sidebar` with `{ filePath }`.
- **Sidebar** — `apps/renderer/src/components/track-sidebar.tsx`. Right-anchored, mounted once in `App.tsx`. Self-listens for `rowboat:open-track-sidebar`; on open, calls `workspace:readFile` and parses tracks from the frontmatter on the renderer side (uses the same `TrackSchema` from `@x/shared`). All mutations go through IPC.
  - Constant top header: Radio icon, "Tracks" title, note name subtitle, X close. Uses the `bg-sidebar` design tokens to match the app's left sidebar.
  - List view: one row per track. Title is `id`; subtitle is the trigger summary (with `Paused ·` prefix); third line is the instruction's first line, truncated. Run button always visible while running, otherwise fades in on hover.
  - Detail view: back arrow + track id; status row (trigger summary + Active/Paused toggle); tabs (`What` / `Schedule` / `Events` / `Details`); advanced raw-YAML editor; danger-zone delete; footer (Edit with Copilot + Run now).
- **Status hook** — `apps/renderer/src/hooks/use-track-status.ts`. Subscribes to `tracks:events` IPC and maintains a `Map<"${id}:${filePath}", RunState>` keyed by composite key.
- **Edit-with-Copilot flow** — sidebar dispatches `rowboat:open-copilot-edit-track` (App.tsx listener handles it via `submitFromPalette`).
- **FrontmatterProperties safety** — `apps/renderer/src/lib/frontmatter.ts` adds `STRUCTURED_KEYS = new Set(['track'])`. `extractAllFrontmatterValues` filters those keys out (so they never appear in the editable property list), and `buildFrontmatter(fields, preserveRaw)` splices the original `track:` block back from `preserveRaw` on save. This means the property panel can edit `tags` / `status` / etc. without ever clobbering the tracks frontmatter.

---

## Prompts Catalog

Every LLM-facing prompt in the feature, with file pointers so you can edit in place. After any edit: `cd apps/x && npm run deps` to rebuild the affected package, then restart the app.

### 1. Routing system prompt (Pass 1 classifier)

- **Purpose**: decide which tracks *might* be relevant to an incoming event. Liberal — prefers false positives; the run-agent does Pass 2.
- **File**: `packages/core/src/knowledge/track/routing.ts` (`ROUTING_SYSTEM_PROMPT`).
- **Output**: structured `Pass1OutputSchema` — `{ candidates: { trackId, filePath }[] }`.
- **Invoked by**: `findCandidates()` per batch of 20 tracks via `generateObject({ model, system, prompt, schema })`.

### 2. Routing user prompt template

- **Purpose**: formats the event and the current batch of tracks into the user message for Pass 1.
- **File**: `packages/core/src/knowledge/track/routing.ts` (`buildRoutingPrompt`).
- **Inputs**: `event` (source, type, createdAt, payload), `batch: ParsedTrack[]` (each: `trackId`, `filePath`, `matchCriteria` — joined from all event triggers, `'; '`-separated).
- **Output**: plain text, two sections — `## Event` and `## Tracks`.

### 3. Track-run agent instructions

- **Purpose**: system prompt for the background agent that rewrites note bodies. Sets tone, defines the section-placement contract (find/create/self-heal), points at the knowledge graph, and prescribes general `workspace-readFile` / `workspace-edit` as the write path.
- **File**: `packages/core/src/knowledge/track/run-agent.ts` (`TRACK_RUN_INSTRUCTIONS`).
- **Inputs**: `${WorkDir}` template literal substituted at module load.
- **Output**: free-form — agent calls tools, ends with a 1-2 sentence summary used as `lastRunSummary`.
- **Invoked by**: `buildTrackRunAgent()`, called during agent runtime setup. Tool set = all `BuiltinTools` except `executeCommand`.

### 4. Track-run agent message (`buildMessage`)

- **Purpose**: the user message seeded into each track-run.
- **File**: `packages/core/src/knowledge/track/runner.ts` (`buildMessage`).
- **Inputs**: `filePath` (presented as `knowledge/${filePath}` in the message), `track.id`, `track.instruction`, all event triggers' `matchCriteria` (only on event runs), `trigger`, optional `context`, plus `localNow` / `tz`.
- **Behavior**: tells the agent to call `workspace-readFile` itself (no body snapshot included, since the body can be long and may have been edited by a concurrent run).

Three branches by `trigger`:
- **`manual`** — base message. If `context` is passed, it's appended as a `**Context:**` section. The `run-track` tool uses this path for both plain refreshes and context-biased backfills.
- **`timed`** — same as `manual`. Called by the scheduler with no `context`.
- **`event`** — adds a Pass 2 decision block listing all event triggers' `matchCriteria` (numbered if multiple) and the event payload, with the directive to skip the edit if the event isn't truly relevant.

### 5. Tracks skill (Copilot-facing)

- **Purpose**: teaches Copilot the frontmatter `track:` model — operational posture (act-first), the strong/medium/anti-signal taxonomy and how to act on each, user-facing language (call them "tracks"; surface the **Track sidebar** by name), the auto-run-once-on-create/edit default, schema, triggers, multi-trigger combos, YAML-safety rules, insertion workflow, and the `run-track` tool with `context` backfills.
- **File**: `packages/core/src/application/assistant/skills/tracks/skill.ts`. Exported `skill` constant.
- **Schema interpolation**: at module load, `stringifyYaml(z.toJSONSchema(TrackSchema))` is interpolated into the "Canonical Schema" section. Edits to `TrackSchema` propagate automatically.
- **Output**: markdown, injected into the Copilot system prompt when `loadSkill('tracks')` fires.
- **Invoked by**: Copilot's `loadSkill` builtin tool. Registration in `skills/index.ts`.

### 6. Copilot trigger paragraph

- **Purpose**: tells Copilot *when* to load the `tracks` skill, and frames how aggressively to act once loaded.
- **File**: `packages/core/src/application/assistant/instructions.ts` (look for the "Tracks (Auto-Updating Notes)" paragraph).
- **Strong signals (load + act without asking)**: cadence words ("every morning / daily / hourly…"), living-document verbs ("keep a running summary of…", "maintain a digest of…"), watch/monitor verbs, pin-live framings ("always show the latest X here"), direct ("track / follow X"), event-conditional ("whenever a relevant email comes in…").
- **Medium signals (load + answer the one-off + offer)**: time-decaying questions ("what's the weather?", "USD/INR right now?", "service X status?"), note-anchored snapshots ("show me my schedule here"), recurring artifacts ("morning briefing", "weekly review", "Acme dashboard"), topic-following / catch-up.
- **Anti-signals (do NOT track)**: definitional questions, one-off lookups, manual document editing.

### 7. `run-track` tool — `context` parameter description

- **Purpose**: a mini-prompt (a Zod `.describe()`) that guides Copilot on when to pass extra context for a run.
- **File**: `packages/core/src/application/lib/builtin-tools.ts` (the `run-track` tool definition).
- **Inputs**: `filePath` (workspace-relative; the tool strips the `knowledge/` prefix internally), `id`, optional `context`.
- **Output**: flows into `triggerTrackUpdate(..., 'manual')` → `buildMessage` → appended as `**Context:**` in the agent message.
- **Key use case**: backfill a newly-created event-driven track so its section isn't empty on day 1.

### 8. Calendar sync digest (event payload template)

- **Purpose**: shapes what the routing classifier sees for a calendar event. Not a system prompt, but a deterministic markdown template that becomes `event.payload`.
- **File**: `packages/core/src/knowledge/sync_calendar.ts` (`summarizeCalendarSync`, wrapped by `publishCalendarSyncEvent()`).
- **Output**: markdown with a counts header, `## Changed events` (per-event block: title, ID, time, organizer, location, attendees, truncated description), `## Deleted event IDs`. Capped at ~50 events; descriptions truncated to 500 chars.
- **Why care**: the quality of Pass 1 matching depends on how clear this payload is.

---

## File Map

| Purpose | File |
|---|---|
| Zod schemas (track, triggers, events, Pass1) | `packages/shared/src/track.ts` |
| IPC channel schemas | `packages/shared/src/ipc.ts` |
| IPC handlers (main process) | `apps/main/src/ipc.ts` |
| Frontmatter helpers (parse / split / join) | `packages/core/src/application/lib/parse-frontmatter.ts` |
| File operations (fetchAll / fetch / updateTrack / replaceTrackYaml / deleteTrack / readNoteBody / list / setActive) | `packages/core/src/knowledge/track/fileops.ts` |
| Scheduler (cron / window / once) | `packages/core/src/knowledge/track/scheduler.ts` |
| Trigger due-check helper | `packages/core/src/knowledge/track/schedule-utils.ts` |
| Event producer + consumer loop | `packages/core/src/knowledge/track/events.ts` |
| Pass 1 routing (LLM classifier) | `packages/core/src/knowledge/track/routing.ts` |
| Run orchestrator (`triggerTrackUpdate`, `buildMessage`) | `packages/core/src/knowledge/track/runner.ts` |
| Track-run agent definition | `packages/core/src/knowledge/track/run-agent.ts` |
| Track bus (pub-sub for lifecycle events) | `packages/core/src/knowledge/track/bus.ts` |
| Track state type | `packages/core/src/knowledge/track/types.ts` |
| Daily-note template + version migration | `packages/core/src/knowledge/ensure_daily_note.ts` |
| Gmail event producer | `packages/core/src/knowledge/sync_gmail.ts` |
| Calendar event producer + digest | `packages/core/src/knowledge/sync_calendar.ts` |
| Copilot skill | `packages/core/src/application/assistant/skills/tracks/skill.ts` |
| Skill registration | `packages/core/src/application/assistant/skills/index.ts` |
| Copilot trigger paragraph | `packages/core/src/application/assistant/instructions.ts` |
| `run-track` builtin tool | `packages/core/src/application/lib/builtin-tools.ts` |
| Editor toolbar (Radio button → sidebar) | `apps/renderer/src/components/editor-toolbar.tsx` |
| Track sidebar (list + detail view) | `apps/renderer/src/components/track-sidebar.tsx` |
| Status hook (`useTrackStatus`) | `apps/renderer/src/hooks/use-track-status.ts` |
| Renderer frontmatter helper (preserves `track:`) | `apps/renderer/src/lib/frontmatter.ts` |
| App-level listeners (sidebar open + Copilot edit) | `apps/renderer/src/App.tsx` |
| CSS (sidebar styles, legacy filename) | `apps/renderer/src/styles/track-modal.css`, `apps/renderer/src/styles/editor.css` |
| Main process startup (schedulers & processors) | `apps/main/src/main.ts` |
