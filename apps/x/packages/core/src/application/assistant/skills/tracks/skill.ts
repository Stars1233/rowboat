import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';
import { TrackSchema } from '@x/shared/dist/track.js';

const schemaYaml = stringifyYaml(z.toJSONSchema(TrackSchema)).trimEnd();

const richBlockMenu = `**5. Rich block render — when the data has a natural visual form.**

The track agent can emit *rich blocks* — special fenced blocks the editor renders as styled UI (charts, calendars, embedded iframes, etc.). When the data fits one of these shapes, instruct the agent explicitly so it doesn't fall back to plain markdown:

- \`table\` — multi-row data, scoreboards, leaderboards. *"Render as a \`table\` block with columns Rank, Title, Points, Comments."*
- \`chart\` — time series, breakdowns, share-of-total. *"Render as a \`chart\` block (line, bar, or pie) with x=date, y=rate."*
- \`mermaid\` — flowcharts, sequence/relationship diagrams, gantt charts. *"Render as a \`mermaid\` diagram."*
- \`calendar\` — upcoming events / agenda. *"Render as a \`calendar\` block."*
- \`email\` — single email thread digest (subject, from, summary, latest body, optional draft). *"Render the most important unanswered thread as an \`email\` block."*
- \`image\` — single image with caption. *"Render as an \`image\` block."*
- \`embed\` — YouTube or Figma. *"Render as an \`embed\` block."*
- \`iframe\` — live dashboards, status pages, anything that benefits from being live not snapshotted. *"Render as an \`iframe\` block pointing to <url>."*
- \`transcript\` — long meeting transcripts (collapsible). *"Render as a \`transcript\` block."*
- \`prompt\` — a "next step" Copilot card the user can click to start a chat. *"End with a \`prompt\` block labeled '<short label>' that runs '<longer prompt to send to Copilot>'."*

You **do not** need to write the block body yourself — describe the desired output in the instruction and the track agent will format it (it knows each block's exact schema). Avoid \`task\` block types — those are user-authored input, not agent output.

- Good: "Show today's calendar events. Render as a \`calendar\` block with \`showJoinButton: true\`."
- Good: "Plot USD/INR over the last 7 days as a \`chart\` block — line chart, x=date, y=rate."
- Bad: "Show today's calendar." (vague — agent may produce a markdown bullet list when the user wants the rich block)`;

export const skill = String.raw`
# Tracks Skill

A track is a directive in a note's YAML frontmatter (under the ` + "`" + `track:` + "`" + ` array) that turns the note's body into a *living* document — refreshed on a schedule or reactively when a matching email / calendar event arrives. A note with no ` + "`" + `track:` + "`" + ` key is just static; one or more entries under it make it live. Users manage their tracks in the **Track sidebar** (Radio icon at the top-right of the editor).

When this skill is loaded, your job is: set up (or update) a track, run it once so the user immediately sees content, and tell them where to manage it.

## Mode: act-first

Track creation and editing are action-first. Read the file, update the frontmatter via ` + "`" + `workspace-edit` + "`" + `, run the track once. Do not ask "Should I make edits directly, or show changes first for approval?" — that prompt belongs to generic document editing, not to tracks.

- If another skill or earlier turn was waiting on edit-mode permission, treat the track request as implicit "direct mode" and proceed.
- You may ask **one** short clarifying question only when genuinely ambiguous (e.g. *which* note). Never ask about permission to edit.
- The Suggested Topics and Background Agent setup flows below are first-turn-confirmation exceptions — leave those intact.

## Reading the user's intent

You're loaded any time the user might be asking for something dynamic. Two postures, depending on signal strength:

### Strong signals — act, then confirm

Just build the track. Don't ask permission. Confirm in one line at the end.

- **Cadence words**: "every morning…", "daily…", "each Monday…", "hourly weather here"
- **Living-document verbs**: "keep a running summary of…", "maintain a digest of…", "build up notes on…", "roll up X here"
- **Watch/monitor verbs**: "watch X", "monitor Y", "keep an eye on Z", "follow the Acme deal", "stay on top of…"
- **Pin-live framings**: "pin live updates of…", "always show the latest X here", "keep this fresh"
- **Direct**: "track X" — the user used the word; you can too in your reply
- **Event-conditional**: "whenever a relevant email comes in, update…", "if anyone mentions X, capture it here"

### Medium signals — answer the one-off, then offer

Answer the user's actual question first. Then add a single-line offer to keep it updated. If they say yes, build the track. If they don't engage, leave it — don't push twice.

- **Time-decaying one-offs**: "what's USD/INR right now?", "top HN stories?", "weather?", "status of service X?"
- **Note-anchored snapshots**: "show me my schedule today", "put my open tasks here", "drop the latest commits here" — especially when in a note context
- **Recurring artifacts**: "I'm starting a weekly review note", "my morning briefing", "a dashboard for the Acme deal"
- **Topic-following / catch-up**: "catch me up on the migration project", "I want to follow Project Apollo"

Offer line shape (one line, concrete):
> "I can keep this updated here, refreshing every morning — want that?"

### Anti-signals — do NOT track

- Definitional questions ("what is X?")
- One-off lookups ("look up X for me")
- Manual document work ("help me write…", "edit this paragraph…")
- General how-to ("how do I do Y?")

## What to say to the user

The user knows the feature as **tracks** and finds them in the **Track sidebar**. Speak in those terms; don't expose internals like "frontmatter", "trigger", or "instruction" in user-facing prose unless the user uses them first.

After creating a track, surface where it lives:
> "Done — I've set up a track here that refreshes every morning. Running it once now so you see content right away. You can manage it from the Track sidebar (Radio icon, top-right of the editor)."

After editing one:
> "Updated. Re-running now so you can see the new output."

When skipping a re-run (because the user said not to or "later"):
> "Updated — I'll let it run on its next trigger."

## What Is a Track (concretely)

**Concrete example** — a note that shows the current Chicago time, refreshed hourly:

` + "```" + `markdown
---
track:
  - id: chicago-time
    instruction: |
      Show the current time in Chicago, IL in 12-hour format.
    active: true
    triggers:
      - type: cron
        expression: "0 * * * *"
---

# Chicago time

(empty — the agent will fill this in on the first run)
` + "```" + `

After the first run, the body might become:

` + "```" + `markdown
# Chicago time

2:30 PM, Central Time
` + "```" + `

Good use cases:
- Weather / air quality for a location
- News digests or headlines
- Stock or crypto prices
- Sports scores
- Service status pages
- Personal dashboards (today's calendar, steps, focus stats)
- Living summaries fed by incoming events (emails, meeting notes)
- Any recurring content that decays fast

## Anatomy

A track lives entirely in the note's frontmatter — there is no inline marker in the body. The agent writes whatever content the instruction demands into the body itself, choosing where to place it based on the existing structure.

The frontmatter block is fenced by ` + "`" + `---` + "`" + ` lines at the very top of the file:

` + "```" + `markdown
---
track:
  - id: <kebab-id>
    instruction: |
      <what the agent should produce>
    active: true
    triggers:
      - type: cron
        expression: "0 * * * *"
---

# Note body
` + "```" + `

A note may have multiple entries under ` + "`" + `track:` + "`" + ` — they run independently. Each entry can have multiple triggers (e.g. an hourly cron AND an event trigger). Omit ` + "`" + `triggers` + "`" + ` for a manual-only track.

## Canonical Schema

Below is the authoritative schema for a single track entry (generated at build time from the TypeScript source — never out of date). Use it to validate every field name, type, and constraint before writing YAML:

` + "```" + `yaml
${schemaYaml}
` + "```" + `

**Runtime-managed fields — never write these yourself:** ` + "`" + `lastRunAt` + "`" + `, ` + "`" + `lastRunId` + "`" + `, ` + "`" + `lastRunSummary` + "`" + `.

## Do Not Set ` + "`" + `model` + "`" + ` or ` + "`" + `provider` + "`" + ` (almost always)

The schema includes optional ` + "`" + `model` + "`" + ` and ` + "`" + `provider` + "`" + ` fields. **Omit them.** A user-configurable global default already picks the right model and provider for tracks; setting per-track values bypasses that and is almost always wrong.

The only time these belong on a track:

- The user **explicitly** named a model or provider for *this specific track* in their request ("use Claude Opus for this one", "force this track onto OpenAI"). Quote the user's wording back when confirming.

Things that are **not** reasons to set these:

- "Tracks should be fast" / "I want a small model" — that's a global preference, not a per-track one. Leave it; the global default exists.
- "This track is complex" — write a clearer instruction; don't reach for a different model.
- "Just to be safe" / "in case it matters" — this is the antipattern. Leave them out.

When in doubt: omit both fields. Never volunteer them. Never include them in a starter template you suggest.

## Choosing an ` + "`" + `id` + "`" + `

- Kebab-case, short, descriptive: ` + "`" + `chicago-time` + "`" + `, ` + "`" + `sfo-weather` + "`" + `, ` + "`" + `hn-top5` + "`" + `, ` + "`" + `btc-usd` + "`" + `.
- **Must be unique within the note's ` + "`" + `track:` + "`" + ` array.** Before inserting, read the file and check existing ` + "`" + `id:` + "`" + ` values.
- If you need disambiguation, add scope: ` + "`" + `btc-price-usd` + "`" + `, ` + "`" + `weather-home` + "`" + `, ` + "`" + `news-ai-2` + "`" + `.
- Don't reuse an old ID even if a previous entry was deleted — pick a fresh one.

## Writing a Good Instruction

### The Frame: This Is a Personal Knowledge Tracker

Track output lives in a personal knowledge base the user scans frequently. Aim for data-forward, scannable output — the answer to "what's current / what changed?" in the fewest words that carry real information. Not prose. Not decoration.

### Core Rules

- **Specific and actionable.** State exactly what to fetch or compute.
- **Single-focus.** One track = one purpose. Split "weather + news + stocks" into three tracks, don't bundle.
- **Imperative voice, 1-3 sentences.**
- **Specify output shape.** Describe it concretely: "one line: ` + "`" + `<temp>°F, <conditions>` + "`" + `", "3-column markdown table", "bulleted digest of 5 items".

### Self-Sufficiency (critical)

The instruction runs later, in a background scheduler, with **no chat context and no memory of this conversation**. It must stand alone.

**Never use phrases that depend on prior conversation or prior runs:**
- "as before", "same style as before", "like last time"
- "keep the format we discussed", "matching the previous output"
- "continue from where you left off" (without stating the state)

If you want consistent style across runs, **describe the style inline** (e.g. "a 3-column markdown table with headers ` + "`" + `Location` + "`" + `, ` + "`" + `Local Time` + "`" + `, ` + "`" + `Offset` + "`" + `"; "a one-line status: HH:MM, conditions, temp"). The track agent only sees your instruction — not this chat, not what you produced last time.

### Output Patterns — Match the Data

Pick a shape that fits what the user is tracking. Five common patterns — the first four are plain markdown; the fifth is a rich rendered block:

**1. Single metric / status line.**
- Good: "Fetch USD/INR. Return one line: ` + "`" + `USD/INR: <rate> (as of <HH:MM IST>)` + "`" + `."
- Bad: "Give me a nice update about the dollar rate."

**2. Compact table.**
- Good: "Show current local time for India, Chicago, Indianapolis as a 3-column markdown table: ` + "`" + `Location | Local Time | Offset vs India` + "`" + `. One row per location, no prose."
- Bad: "Show a polished, table-first world clock with a pleasant layout."

**3. Rolling digest.**
- Good: "Summarize the top 5 HN front-page stories as bullets: ` + "`" + `- <title> (<points> pts, <comments> comments)` + "`" + `. No commentary."
- Bad: "Give me the top HN stories with thoughtful takeaways."

**4. Status / threshold watch.**
- Good: "Check https://status.example.com. Return one line: ` + "`" + `✓ All systems operational` + "`" + ` or ` + "`" + `⚠ <component>: <status>` + "`" + `. If degraded, add one bullet per affected component."
- Bad: "Keep an eye on the status page and tell me how it looks."

${richBlockMenu}

### Anti-Patterns

- **Decorative adjectives** describing the output: "polished", "clean", "beautiful", "pleasant", "nicely formatted" — they tell the agent nothing concrete.
- **References to past state** without a mechanism to access it ("as before", "same as last time").
- **Bundling multiple purposes** into one instruction — split into separate tracks.
- **Open-ended prose requests** ("tell me about X", "give me thoughts on X").

## YAML String Style (critical — read before writing any ` + "`" + `instruction` + "`" + ` or event-trigger ` + "`" + `matchCriteria` + "`" + `)

The two free-form fields — ` + "`" + `instruction` + "`" + ` and event-trigger ` + "`" + `matchCriteria` + "`" + ` — are where YAML parsing usually breaks. The runner re-emits the full frontmatter every time it writes ` + "`" + `lastRunAt` + "`" + `, ` + "`" + `lastRunSummary` + "`" + `, etc., and the YAML library may re-flow long plain (unquoted) strings onto multiple lines. Once that happens, any ` + "`" + `:` + "`" + ` **followed by a space** inside the value silently corrupts the entry: YAML interprets the ` + "`" + `:` + "`" + ` as a new key/value separator and the instruction gets truncated.

### The rule: always use a safe scalar style

**Default to the literal block scalar (` + "`" + `|` + "`" + `) for ` + "`" + `instruction` + "`" + ` and event-trigger ` + "`" + `matchCriteria` + "`" + `, every time.**

### Preferred: literal block scalar (` + "`" + `|` + "`" + `)

` + "```" + `yaml
track:
  - id: world-clock
    instruction: |
      Show current local time for India, Chicago, and Indianapolis as a
      3-column markdown table: Location | Local Time | Offset vs India.
      One row per location, 24-hour time (HH:MM), no extra prose.
    active: true
    triggers:
      - type: cron
        expression: "0 * * * *"
      - type: event
        matchCriteria: |
          Emails from the finance team about Q3 budget or OKRs.
` + "```" + `

- ` + "`" + `|` + "`" + ` preserves line breaks verbatim. Colons, ` + "`" + `#` + "`" + `, quotes, leading ` + "`" + `-` + "`" + `, percent signs — all literal. No escaping needed.
- **Indent every content line by 2 spaces** relative to the key. Use spaces, never tabs.
- Leave a real newline after ` + "`" + `|` + "`" + ` — content starts on the next line.

### Acceptable alternative: double-quoted on a single line

Fine for short single-sentence fields:

` + "```" + `yaml
track:
  - id: chicago-time
    instruction: "Show the current time in Chicago, IL in 12-hour format."
    active: true
` + "```" + `

### Do NOT use plain (unquoted) scalars for these two fields

Even if the current value looks safe, a future edit may introduce a ` + "`" + `:` + "`" + ` or ` + "`" + `#` + "`" + `, and a future re-emit may fold the line. The ` + "`" + `|` + "`" + ` style is safe under **all** future edits.

### Never-hand-write fields

` + "`" + `lastRunAt` + "`" + `, ` + "`" + `lastRunId` + "`" + `, ` + "`" + `lastRunSummary` + "`" + ` are owned by the runner. Don't touch them — don't even try to style them. If your edit's ` + "`" + `oldString` + "`" + ` happens to include these, copy them byte-for-byte into ` + "`" + `newString` + "`" + ` unchanged.

## Triggers

A track has zero or more **triggers** under a single ` + "`" + `triggers:` + "`" + ` array. Each trigger is one of four types:

- ` + "`" + `cron` + "`" + ` — fires at an exact time, recurring
- ` + "`" + `window` + "`" + ` — once per day, anywhere inside a time-of-day band
- ` + "`" + `once` + "`" + ` — one-shot at a future time
- ` + "`" + `event` + "`" + ` — fires when a matching event arrives (emails, calendar, etc.)

A track can carry **multiple triggers** of any mix. Omit ` + "`" + `triggers` + "`" + ` (or use an empty array) for a **manual-only** track — the user triggers it via the Run button in the sidebar.

### ` + "`" + `cron` + "`" + ` trigger

` + "```" + `yaml
triggers:
  - type: cron
    expression: "0 * * * *"
` + "```" + `

### ` + "`" + `window` + "`" + ` trigger

` + "```" + `yaml
triggers:
  - type: window
    startTime: "09:00"
    endTime: "12:00"
` + "```" + `

Fires **at most once per day, anywhere inside the time-of-day band** (24-hour HH:MM, local). The day's cycle is anchored at ` + "`" + `startTime` + "`" + ` — once a fire lands at-or-after today's start, the trigger is done for the day. Use this when the user wants something to happen "in the morning" rather than at an exact clock time. Forgiving by design: if the app isn't open at the band's start, it still fires the moment the user opens it inside the band.

### ` + "`" + `once` + "`" + ` trigger

` + "```" + `yaml
triggers:
  - type: once
    runAt: "2026-04-14T09:00:00"
` + "```" + `

Local time, no ` + "`" + `Z` + "`" + ` suffix.

### ` + "`" + `event` + "`" + ` trigger

` + "```" + `yaml
triggers:
  - type: event
    matchCriteria: |
      Emails about Q3 planning, roadmap decisions, or quarterly OKRs.
` + "```" + `

How event triggers work:
1. When a new event arrives, a fast LLM classifier checks each event trigger's ` + "`" + `matchCriteria` + "`" + ` against the event content.
2. If it might match, the track-run agent receives both the event payload and the existing note body, and decides whether to actually update.
3. If the event isn't truly relevant on closer inspection, the agent skips the update — no fabricated content.

### Combining multiple triggers

A single track can have any combination — e.g. an hourly cron AND an event trigger:

` + "```" + `yaml
track:
  - id: q3-emails
    instruction: |
      Maintain a running summary of decisions and open questions about Q3 planning.
    active: true
    triggers:
      - type: cron
        expression: "0 9 * * 1-5"
      - type: event
        matchCriteria: |
          Emails about Q3 planning, roadmap decisions, or quarterly OKRs.
` + "```" + `

This track refreshes on schedule (weekdays at 9am) AND on every relevant incoming email.

### Cron cookbook

- ` + "`" + `"*/15 * * * *"` + "`" + ` — every 15 minutes
- ` + "`" + `"0 * * * *"` + "`" + ` — every hour on the hour
- ` + "`" + `"0 8 * * *"` + "`" + ` — daily at 8am
- ` + "`" + `"0 9 * * 1-5"` + "`" + ` — weekdays at 9am
- ` + "`" + `"0 0 * * 0"` + "`" + ` — Sundays at midnight
- ` + "`" + `"0 0 1 * *"` + "`" + ` — first of month at midnight

## Insertion Workflow

**Reminder:** once you have enough to act, act. Do not pause to ask about edit mode.

### Adding a track to an existing note

1. ` + "`" + `workspace-readFile({ path })` + "`" + ` — re-read fresh.
2. Inspect existing frontmatter (the ` + "`" + `---` + "`" + `-fenced block at the top, if any). Note the existing ` + "`" + `track:` + "`" + ` ids if present.
3. Construct the new track entry as YAML.
4. ` + "`" + `workspace-edit` + "`" + `:
   - **If the note has frontmatter and a ` + "`" + `track:` + "`" + ` array already**: anchor on a unique line in/near the array and splice your new entry in.
   - **If the note has frontmatter but no ` + "`" + `track:` + "`" + ` array**: anchor on the closing ` + "`" + `---` + "`" + ` of the frontmatter, and insert ` + "`" + `track:\n  - id: ...` + "`" + ` etc. just before it.
   - **If the note has no frontmatter at all**: anchor on the very first line of the file. Replace it with a new frontmatter block (` + "`" + `---\n` + "`" + ` ... ` + "`" + `\n---\n` + "`" + ` followed by the original first line).

### Sidebar chat with a specific note

1. If a file is mentioned/attached, read it.
2. If ambiguous, ask one question: "Which note should I add the track to?"
3. Update the note's frontmatter ` + "`" + `track:` + "`" + ` array using the workflow above.

### No note context at all

Ask one question: "Which note should this track live in?" Don't create a new note unless the user asks.

### Suggested Topics exploration flow

Sometimes the user arrives from the Suggested Topics panel and gives you a prompt like:
- "I am exploring a suggested topic card from the Suggested Topics panel."
- a title, category, description, and target folder such as ` + "`" + `knowledge/Topics/` + "`" + ` or ` + "`" + `knowledge/People/` + "`" + `

In that flow:
1. On the first turn, **do not create or modify anything yet**. Briefly explain the tracking note you can set up and ask for confirmation.
2. If the user clearly confirms ("yes", "set it up", "do it"), treat that as explicit permission to proceed.
3. Before creating a new note, search the target folder for an existing matching note and update it if one already exists.
4. If no matching note exists and the prompt gave you a target folder, create the new note there without bouncing back to ask.
5. Use the card title as the default note title / filename unless a small normalization is clearly needed.
6. Keep the surrounding note scaffolding minimal but useful. The track entry should be the core of the note.

### Background agent setup flow

Sometimes the user arrives from the Background agents panel and wants help creating a new background agent without naming a note yet.

In this flow, treat "background agent" and "track" as the same feature. The user-facing term can stay "background agent", but the implementation is a track in a note's frontmatter. Do **not** claim these are different systems.

In that flow:
1. On the first turn, **do not create or modify anything yet**. Briefly explain what you can set up, say you will put it in ` + "`" + `knowledge/Tasks/` + "`" + ` by default, and ask what it should monitor plus how often it should run.
2. **Do not** ask the user where the results should live unless they explicitly said they want a different folder.
3. If the user clearly confirms later, treat ` + "`" + `knowledge/Tasks/` + "`" + ` as the default target folder.
4. Before creating a new note there, search ` + "`" + `knowledge/Tasks/` + "`" + ` for an existing matching note and update it if one already exists.
5. If ` + "`" + `knowledge/Tasks/` + "`" + ` does not exist, create it as part of setup.
6. Keep the surrounding note scaffolding minimal but useful.

## The Exact Frontmatter Shape

For a brand-new note:

` + "```" + `markdown
---
track:
  - id: <kebab-id>
    instruction: |
      <instruction, indented 2 spaces, may span multiple lines>
    active: true
    triggers:
      - type: cron
        expression: "0 * * * *"
---

# <Note title>
` + "```" + `

**Rules:**
- ` + "`" + `track:` + "`" + ` is at the top level of the frontmatter, never nested.
- Each entry is a list item starting with ` + "`" + `- id:` + "`" + `. 2-space YAML indent. No tabs.
- ` + "`" + `triggers:` + "`" + ` is an array. Omit it for a manual-only track. Multiple entries are allowed (any mix of cron / window / once / event).
- **Always use the literal block scalar (` + "`" + `|` + "`" + `)** for ` + "`" + `instruction` + "`" + ` and event-trigger ` + "`" + `matchCriteria` + "`" + `.
- **Always quote cron expressions** in YAML — they contain spaces and ` + "`" + `*` + "`" + `.
- The note body below the frontmatter can start empty, with a heading, or with whatever scaffolding the user wants. The track agent will edit the body on its first run.

## After Creating or Editing a Track

**Run it once.** Always. The only exception is when the user explicitly said *not* to ("don't run yet", "I'll run it later", "no need to run it now"). Use the ` + "`" + `run-track` + "`" + ` tool — same as the user clicking Run in the sidebar.

Why default-on:
- For event-driven tracks (with ` + "`" + `event` + "`" + ` triggers), the body stays empty until the next matching event arrives. Running once gives the user immediate content.
- For tracks that pull from existing local data (synced emails, calendar, meeting notes), running with a backfill ` + "`" + `context` + "`" + ` (see below) seeds rich initial content.
- After an edit, the user expects to see the updated output without an extra round-trip.

Confirm in one line and tell the user where to find it:
> "Done — I've set up a track refreshing hourly. Running it once now so you see content right away. You can manage it from the Track sidebar."

For an edit:
> "Updated. Re-running now so you can see the new output."

If you skipped the re-run (user said not to):
> "Updated — I'll let it run on its next trigger."

**Do not** write content into the note body yourself — that's the track agent's job, delegated via ` + "`" + `run-track` + "`" + `.

## Using the ` + "`" + `run-track` + "`" + ` tool

` + "`" + `run-track` + "`" + ` triggers a single run right now. You can pass an optional ` + "`" + `context` + "`" + ` string to bias *this run only* without modifying the track's instruction — the difference between a stock refresh and a smart backfill.

### Backfill ` + "`" + `context` + "`" + ` examples

- New event-driven track on Q3 emails → run with:
  > context: "Initial backfill — scan ` + "`" + `gmail_sync/` + "`" + ` for emails from the last 90 days about Q3 planning, OKRs, and roadmap, and synthesize the initial summary."
- New track on this week's customer calls → run with:
  > context: "Backfill from this week's meeting notes in ` + "`" + `granola_sync/` + "`" + ` and ` + "`" + `fireflies_sync/` + "`" + `."
- Manual refresh after the user mentions a recent change:
  > context: "Focus on changes from the last 7 days only."
- Plain refresh (user said "run it now"): **omit ` + "`" + `context` + "`" + `**. Don't invent it.

### Reading the result

The tool returns ` + "`" + `{ success, runId, action, summary, contentAfter, error }` + "`" + `:

- ` + "`" + `action: 'replace'` + "`" + ` → body changed. Confirm in one line; optionally cite the first line of ` + "`" + `contentAfter` + "`" + `.
- ` + "`" + `action: 'no_update'` + "`" + ` → agent decided nothing needed to change. Tell the user briefly; ` + "`" + `summary` + "`" + ` usually explains why.
- ` + "`" + `error: 'Already running'` + "`" + ` → another run is in flight; tell the user to retry shortly.
- Other ` + "`" + `error` + "`" + ` → surface concisely.

### Don'ts

- **Don't run more than once** per user-facing action — one tool call per turn.
- **Don't pass ` + "`" + `context` + "`" + `** for a plain refresh — it can mislead the agent.
- **Don't write content into the note body yourself** — always delegate via ` + "`" + `run-track` + "`" + `.

## Don'ts

- **Don't reuse** an existing ` + "`" + `id` + "`" + ` in the same note's ` + "`" + `track:` + "`" + ` array.
- **Don't add ` + "`" + `triggers` + "`" + `** if the user explicitly wants a manual-only track.
- **Don't write** ` + "`" + `lastRunAt` + "`" + `, ` + "`" + `lastRunId` + "`" + `, or ` + "`" + `lastRunSummary` + "`" + ` — runtime-managed.
- **Don't schedule** with ` + "`" + `"* * * * *"` + "`" + ` (every minute) unless the user explicitly asks.
- **Don't add a ` + "`" + `Z` + "`" + ` suffix** on ` + "`" + `runAt` + "`" + ` — local time only.
- **Don't use ` + "`" + `workspace-writeFile` + "`" + `** to rewrite the whole file — always ` + "`" + `workspace-edit` + "`" + ` with a unique anchor.

## Editing or Removing an Existing Track

**Change triggers or instruction:** ` + "`" + `workspace-edit` + "`" + ` the relevant fields inside the ` + "`" + `track:` + "`" + ` array. Anchor on the unique ` + "`" + `id: <id>` + "`" + ` line plus a few surrounding lines.

**Pause without deleting:** flip ` + "`" + `active: false` + "`" + `.

**Remove entirely:** ` + "`" + `workspace-edit` + "`" + ` with ` + "`" + `oldString` + "`" + ` = the full track entry (from its ` + "`" + `- id:` + "`" + ` line down to just before the next ` + "`" + `- id:` + "`" + ` line or the closing ` + "`" + `---` + "`" + ` of the frontmatter), ` + "`" + `newString` + "`" + ` = empty. The note body is left alone — if you want to clear leftover agent output, do that as a separate edit.

## Quick Reference

Minimal template (frontmatter only):

` + "```" + `yaml
track:
  - id: <kebab-id>
    instruction: |
      <what to produce — always use ` + "`" + `|` + "`" + `, indented 2 spaces>
    active: true
    triggers:
      - type: cron
        expression: "0 * * * *"
` + "```" + `

Top cron expressions: ` + "`" + `"0 * * * *"` + "`" + ` (hourly), ` + "`" + `"0 8 * * *"` + "`" + ` (daily 8am), ` + "`" + `"0 9 * * 1-5"` + "`" + ` (weekdays 9am), ` + "`" + `"*/15 * * * *"` + "`" + ` (every 15m).

YAML style reminder: ` + "`" + `instruction` + "`" + ` and event-trigger ` + "`" + `matchCriteria` + "`" + ` are **always** ` + "`" + `|` + "`" + ` block scalars. Never plain. Never leave a plain scalar in place when editing.
`;

export default skill;
