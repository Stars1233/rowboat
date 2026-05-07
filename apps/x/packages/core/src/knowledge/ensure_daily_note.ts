import path from 'path';
import fs from 'fs';
import { stringify as stringifyYaml } from 'yaml';
import { TrackSchema } from '@x/shared/dist/track.js';
import { WorkDir } from '../config/config.js';
import { splitFrontmatter } from '../application/lib/parse-frontmatter.js';
import z from 'zod';

const KNOWLEDGE_DIR = path.join(WorkDir, 'knowledge');
const DAILY_NOTE_PATH = path.join(KNOWLEDGE_DIR, 'Today.md');

// Bump this whenever the canonical Today.md template changes (TRACKS list,
// instructions, default body, etc.). On app start, ensureDailyNote() compares
// the on-disk `templateVersion` against this constant — if older or missing,
// the existing file is renamed to Today.md.bkp.<ISO-stamp> and replaced with
// the new template, preserving the body byte-for-byte.
const CANONICAL_DAILY_NOTE_VERSION = 1;

// Window triggers below fire once per day, anywhere inside their time-of-day
// band — so the user opening the app late in the morning still gets the
// morning run. See schedule-utils.ts for the exact semantics.

const TRACKS: z.infer<typeof TrackSchema>[] = [
    {
        id: 'overview',
        instruction:
`In a section titled "Overview" at the top of the note: 2–3 prose sentences greeting the user and reading the day (warm, confident tone — use today's calendar density from calendar_sync/ and the existing Priorities section if populated). Below the prose, render exactly one \`image\` block fitting the mood (use weather + calendar density as cues). Source the image via web-search from a permissive host (Unsplash/Pexels/Pixabay/Wikimedia, direct .jpg/.png/.webp URLs only); fall back to NASA APOD (https://apod.nasa.gov/apod/astropix.html) if nothing suitable. Skip the update if the prior content is still suitable and less than 24h old. VERY IMPORTANT: Ensure that image is wide / low-height!`,
        active: true,
        triggers: [
            // Three windows give the user a fresh ranking morning, midday, and
            // post-lunch even with no events landing in between.
            { type: 'window', startTime: '08:00', endTime: '12:00' },
            { type: 'window', startTime: '12:00', endTime: '15:00' },
            { type: 'window', startTime: '15:00', endTime: '18:00' },
        ],
    },
    {
        id: 'calendar',
        instruction:
`In a section titled "Calendar", emit today's meetings as a \`calendar\` block titled "Today's Meetings". Read calendar_sync/ via workspace-readdir → workspace-readFile each .json. Filter to today; after 10am drop meetings that have already ended. Always emit the block (use \`events: []\` when empty). Set \`showJoinButton: true\` if any event has a conferenceLink.`,
        active: true,
        triggers: [{
            type: 'event',
            matchCriteria:
`Calendar event changes affecting today — additions, updates, cancellations, reschedules.`,
        }],
    },
    {
        id: 'emails',
        instruction:
`In a section titled "Emails", maintain a digest of email threads worth attention today. Output everything as a **single** fenced code block with language \`emails\` (plural — never individual \`email\` blocks per thread). The body must be JSON shaped \`{"title":"Today's Emails","emails":[...]}\`.

Each entry in the array: \`threadId\`, \`subject\`, \`from\`, \`date\`, \`summary\`, \`latest_email\`. For threads that need a reply, add \`draft_response\` written in the user's voice — direct, informal, no fluff. For FYI threads, omit \`draft_response\`.

Skip marketing, auto-notifications, and closed threads. Without an event payload, scan gmail_sync/ via workspace-readdir (skip sync_state.json and attachments/), prioritizing threads with frontmatter action = "reply" or "respond". With an event payload, integrate any qualifying new threads into the existing digest (add a new entry for a new threadId; update the existing entry if the threadId is already shown). Do not re-list threads the user has already seen unless their state changed.

If nothing qualifies: "No new emails."`,
        active: true,
        triggers: [{
            type: 'event',
            matchCriteria:
`New or updated email threads that may need the user's attention today — drafts to send, replies to write, urgent requests, time-sensitive info. Skip marketing, newsletters, auto-notifications, and chatter on closed threads.`,
        }],
    },
    {
        id: 'what-you-missed',
        instruction:
`In a section titled "What you missed", write a short markdown summary of yesterday's meetings + emails that matter this morning. Pull decisions / action items from knowledge/Meetings/<source>/<yesterday>/ (workspace-readdir recursive on knowledge/Meetings, filter folders matching yesterday's date, read each file). Skim gmail_sync/ for threads that went unresolved. Skip recurring/routine events. If nothing notable: "Quiet day yesterday — nothing to flag."`,
        active: true,
        triggers: [
            // Three windows give the user a fresh ranking morning, midday, and
            // post-lunch even with no events landing in between.
            { type: 'window', startTime: '08:00', endTime: '12:00' },
            { type: 'window', startTime: '12:00', endTime: '15:00' },
            { type: 'window', startTime: '15:00', endTime: '18:00' },
        ],
    },
    {
        id: 'priorities',
        instruction:
`In a section titled "Priorities", a ranked markdown list of actionable items the user should focus on today.

Sources: yesterday's meeting action items (knowledge/Meetings/<source>/<yesterday>/), open follow-ups across knowledge/ (workspace-grep for "- [ ]"), the "What you missed" section.

Don't list calendar events as tasks (Calendar section has them) and don't list trivial admin. Rank by importance; note time-sensitivity inline.

With an event payload (gmail or calendar): re-emit the full list only if the event genuinely shifts priorities (urgent reply, deadline arrival, blocking reschedule). Otherwise skip the update.

If nothing pressing: "No pressing tasks today — good day to make progress on bigger items."`,
        active: true,
        triggers: [
            // Three windows give the user a fresh ranking morning, midday, and
            // post-lunch even with no events landing in between.
            { type: 'window', startTime: '08:00', endTime: '12:00' },
            { type: 'window', startTime: '12:00', endTime: '15:00' },
            { type: 'window', startTime: '15:00', endTime: '18:00' },
            {
                type: 'event',
                matchCriteria:
`New or updated email threads that may shift today's priorities — urgent reply requests, deadline-bearing items, escalations from people the user cares about.`,
            },
            {
                type: 'event',
                matchCriteria:
`Calendar changes today that may shift priorities — a meeting moved to clash with a deadline, an unexpected event added, a key meeting cancelled freeing up time.`,
            },
        ],
    },
];

function buildDailyNoteContent(body: string = '# Today\n'): string {
    const fm = stringifyYaml(
        { templateVersion: CANONICAL_DAILY_NOTE_VERSION, track: TRACKS },
        { lineWidth: 0, blockQuote: 'literal' },
    ).trimEnd();
    return `---\n${fm}\n---\n${body}`;
}

function readCurrentTemplateVersion(): number {
    if (!fs.existsSync(DAILY_NOTE_PATH)) return -1;
    const raw = fs.readFileSync(DAILY_NOTE_PATH, 'utf-8');
    const { frontmatter } = splitFrontmatter(raw);
    const v = frontmatter.templateVersion;
    return typeof v === 'number' ? v : 0;
}

export function ensureDailyNote(): void {
    // Fresh install — no existing file.
    if (!fs.existsSync(DAILY_NOTE_PATH)) {
        fs.writeFileSync(DAILY_NOTE_PATH, buildDailyNoteContent(), 'utf-8');
        console.log(`[DailyNote] Created Today.md (v${CANONICAL_DAILY_NOTE_VERSION})`);
        return;
    }

    // Up-to-date — nothing to do.
    const currentVersion = readCurrentTemplateVersion();
    if (currentVersion >= CANONICAL_DAILY_NOTE_VERSION) return;

    // Migrate aggressively: rename existing → backup, write a fresh canonical
    // template (no body carried over). Today.md is a flagship demo whose
    // content is meant to be regenerated by the tracks anyway — preserving the
    // old body just leaves orphan sections behind on rename/restructure. The
    // .bkp file is the recovery path; its name doesn't end in `.md`, so the
    // scheduler and event router naturally skip it. Pre-rewrite inline-fence
    // notes are caught by this same path.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${DAILY_NOTE_PATH}.bkp.${stamp}`;
    fs.renameSync(DAILY_NOTE_PATH, backupPath);
    fs.writeFileSync(DAILY_NOTE_PATH, buildDailyNoteContent(), 'utf-8');
    console.log(
        `[DailyNote] Migrated v${currentVersion} → v${CANONICAL_DAILY_NOTE_VERSION}; ` +
        `previous version saved to ${backupPath}`,
    );
}
