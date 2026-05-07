import z from 'zod';
import { fetchAll, updateTrack, readNoteBody } from './fileops.js';
import { createRun, createMessage } from '../../runs/runs.js';
import { getTrackBlockModel } from '../../models/defaults.js';
import { extractAgentResponse, waitForRunCompletion } from '../../agents/utils.js';
import { trackBus } from './bus.js';
import type { TrackStateSchema } from './types.js';
import { PrefixLogger } from '@x/shared/dist/prefix-logger.js';

export interface TrackUpdateResult {
    trackId: string;
    runId: string | null;
    action: 'replace' | 'no_update';
    contentBefore: string | null;
    contentAfter: string | null;
    summary: string | null;
    error?: string;
}

// ---------------------------------------------------------------------------
// Agent run
// ---------------------------------------------------------------------------

function buildMessage(
    filePath: string,
    track: z.infer<typeof TrackStateSchema>,
    trigger: 'manual' | 'timed' | 'event',
    context?: string,
): string {
    const now = new Date();
    const localNow = now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Workspace-relative path the agent's tools (workspace-readFile,
    // workspace-edit) expect. Internal fileops storage is knowledge/-relative,
    // so always prefix here when handing it to the agent.
    const wsPath = `knowledge/${filePath}`;

    let msg = `Update track **${track.track.id}** in \`${wsPath}\`.

**Time:** ${localNow} (${tz})

**Instruction:**
${track.track.instruction}

Start by calling \`workspace-readFile\` on \`${wsPath}\` to read the current note (frontmatter + body) — the body may be long and you should fetch it yourself rather than rely on a snapshot. Then use \`workspace-edit\` to make whatever content changes the instruction requires. Do not modify the YAML frontmatter at the top of the file — that block is owned by the user and the runtime.`;

    if (trigger === 'event') {
        const eventCriteria = (track.track.triggers ?? [])
            .filter(t => t.type === 'event')
            .map(t => t.matchCriteria)
            .filter(Boolean);
        const criteriaText = eventCriteria.length === 0
            ? '(none — should not happen for event-triggered runs)'
            : eventCriteria.length === 1
                ? eventCriteria[0]
                : eventCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
        msg += `

**Trigger:** Event match (a Pass 1 routing classifier flagged this track as potentially relevant to the event below)

**Event match criteria for this track:**
${criteriaText}

**Event payload:**
${context ?? '(no payload)'}

**Decision:** Determine whether this event genuinely warrants updating the note. If the event is not meaningfully relevant on closer inspection, skip the update — do not call \`workspace-edit\`. Only edit the file if the event provides new or changed information that should be reflected in the note.`;
    } else if (context) {
        msg += `\n\n**Context:**\n${context}`;
    }

    return msg;
}

// ---------------------------------------------------------------------------
// Concurrency guard
// ---------------------------------------------------------------------------

const runningTracks = new Set<string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trigger an update for a specific track.
 * Can be called by any trigger system (manual, cron, event matching).
 */
export async function triggerTrackUpdate(
    trackId: string,
    filePath: string,
    context?: string,
    trigger: 'manual' | 'timed' | 'event' = 'manual',
): Promise<TrackUpdateResult> {
    const key = `${trackId}:${filePath}`;
    const logger = new PrefixLogger('track:runner');
    logger.log('triggering track update', trackId, filePath, trigger, context);
    if (runningTracks.has(key)) {
        logger.log('skipping, already running');
        return { trackId, runId: null, action: 'no_update', contentBefore: null, contentAfter: null, summary: null, error: 'Already running' };
    }
    runningTracks.add(key);

    try {
        const tracks = await fetchAll(filePath);
        logger.log('fetched tracks from file', tracks);
        const track = tracks.find(t => t.track.id === trackId);
        if (!track) {
            logger.log('track not found', trackId, filePath, trigger, context);
            return { trackId, runId: null, action: 'no_update', contentBefore: null, contentAfter: null, summary: null, error: 'Track not found' };
        }

        const bodyBefore = await readNoteBody(filePath);

        const model = track.track.model ?? await getTrackBlockModel();
        const agentRun = await createRun({
            agentId: 'track-run',
            model,
            ...(track.track.provider ? { provider: track.track.provider } : {}),
            useCase: 'track_block',
            subUseCase: 'run',
        });

        // Set lastRunAt and lastRunId immediately (before agent executes) so
        // the scheduler's next poll won't re-trigger this track.
        await updateTrack(filePath, trackId, {
            lastRunAt: new Date().toISOString(),
            lastRunId: agentRun.id,
        });

        await trackBus.publish({
            type: 'track_run_start',
            trackId,
            filePath,
            trigger,
            runId: agentRun.id,
        });

        try {
            await createMessage(agentRun.id, buildMessage(filePath, track, trigger, context));
            await waitForRunCompletion(agentRun.id);
            const summary = await extractAgentResponse(agentRun.id);

            const bodyAfter = await readNoteBody(filePath);
            const didUpdate = bodyAfter !== bodyBefore;

            // Patch summary into frontmatter on completion.
            await updateTrack(filePath, trackId, {
                lastRunSummary: summary ?? undefined,
            });

            await trackBus.publish({
                type: 'track_run_complete',
                trackId,
                filePath,
                runId: agentRun.id,
                summary: summary ?? undefined,
            });

            return {
                trackId,
                runId: agentRun.id,
                action: didUpdate ? 'replace' : 'no_update',
                contentBefore: bodyBefore,
                contentAfter: bodyAfter,
                summary,
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            await trackBus.publish({
                type: 'track_run_complete',
                trackId,
                filePath,
                runId: agentRun.id,
                error: msg,
            });

            return { trackId, runId: agentRun.id, action: 'no_update', contentBefore: bodyBefore, contentAfter: null, summary: null, error: msg };
        }
    } finally {
        runningTracks.delete(key);
    }
}
