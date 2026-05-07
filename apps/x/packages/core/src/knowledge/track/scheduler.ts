import { PrefixLogger } from '@x/shared';
import * as workspace from '../../workspace/workspace.js';
import { fetchAll } from './fileops.js';
import { triggerTrackUpdate } from './runner.js';
import { isTriggerDue, type TimedTrigger } from './schedule-utils.js';

const log = new PrefixLogger('TrackScheduler');
const POLL_INTERVAL_MS = 15_000; // 15 seconds

async function listKnowledgeMarkdownFiles(): Promise<string[]> {
    try {
        const entries = await workspace.readdir('knowledge', { recursive: true });
        return entries
            .filter(e => e.kind === 'file' && e.name.endsWith('.md'))
            .map(e => e.path.replace(/^knowledge\//, ''));
    } catch {
        return [];
    }
}

async function processScheduledTracks(): Promise<void> {
    const relativePaths = await listKnowledgeMarkdownFiles();
    log.log(`Scanning ${relativePaths.length} markdown files`);

    for (const relativePath of relativePaths) {
        let tracks;
        try {
            tracks = await fetchAll(relativePath);
        } catch {
            continue;
        }

        for (const trackState of tracks) {
            const { track } = trackState;
            if (!track.active) continue;
            if (!track.triggers || track.triggers.length === 0) continue;

            const timed: TimedTrigger[] = track.triggers.filter(
                (t): t is TimedTrigger => t.type !== 'event',
            );
            if (timed.length === 0) continue;

            const dueTrigger = timed.find(t => isTriggerDue(t, track.lastRunAt ?? null));
            if (!dueTrigger) {
                log.log(`Track "${track.id}" in ${relativePath}: ${timed.length} timed trigger(s), none due`);
                continue;
            }

            log.log(`Triggering "${track.id}" in ${relativePath} (matched ${dueTrigger.type})`);
            triggerTrackUpdate(track.id, relativePath, undefined, 'timed').catch(err => {
                log.log(`Error running ${track.id}:`, err);
            });
        }
    }
}

export async function init(): Promise<void> {
    log.log(`Starting, polling every ${POLL_INTERVAL_MS / 1000}s`);

    // Initial run
    await processScheduledTracks();

    // Periodic polling
    while (true) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
            await processScheduledTracks();
        } catch (error) {
            log.log('Error in main loop:', error);
        }
    }
}
