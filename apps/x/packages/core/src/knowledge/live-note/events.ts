import fs from 'fs';
import path from 'path';
import { PrefixLogger, liveNote } from '@x/shared';
import type { KnowledgeEvent } from '@x/shared/dist/live-note.js';
import { WorkDir } from '../../config/config.js';
import * as workspace from '../../workspace/workspace.js';
import { fetchLiveNote } from './fileops.js';
import { runLiveNoteAgent } from './runner.js';
import { findCandidates, type ParsedLiveNote } from './routing.js';
import type { IMonotonicallyIncreasingIdGenerator } from '../../application/lib/id-gen.js';
import container from '../../di/container.js';

const POLL_INTERVAL_MS = 5_000; // 5 seconds — events should feel responsive
const EVENTS_DIR = path.join(WorkDir, 'events');
const PENDING_DIR = path.join(EVENTS_DIR, 'pending');
const DONE_DIR = path.join(EVENTS_DIR, 'done');

const log = new PrefixLogger('LiveNote:Events');

/**
 * Write a KnowledgeEvent to the events/pending/ directory.
 * Filename is a monotonically increasing ID so events sort by creation order.
 * Call this function in chronological order (oldest event first) within a sync batch
 * to ensure correct ordering.
 */
export async function createEvent(event: Omit<KnowledgeEvent, 'id'>): Promise<void> {
    fs.mkdirSync(PENDING_DIR, { recursive: true });

    const idGen = container.resolve<IMonotonicallyIncreasingIdGenerator>('idGenerator');
    const id = await idGen.next();

    const fullEvent: KnowledgeEvent = { id, ...event };
    const filePath = path.join(PENDING_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(fullEvent, null, 2), 'utf-8');
}

function ensureDirs(): void {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.mkdirSync(DONE_DIR, { recursive: true });
}

async function listEventEligibleLiveNotes(): Promise<ParsedLiveNote[]> {
    const out: ParsedLiveNote[] = [];
    let entries;
    try {
        entries = await workspace.readdir('knowledge', { recursive: true });
    } catch {
        return out;
    }
    const mdFiles = entries
        .filter(e => e.kind === 'file' && e.name.endsWith('.md'))
        .map(e => e.path.replace(/^knowledge\//, ''));

    for (const filePath of mdFiles) {
        let live;
        try {
            live = await fetchLiveNote(filePath);
        } catch {
            continue;
        }
        if (!live) continue;
        if (live.active === false) continue;

        const eventMatchCriteria = live.triggers?.eventMatchCriteria;
        if (!eventMatchCriteria) continue; // not event-eligible

        out.push({
            filePath,
            objective: live.objective,
            eventMatchCriteria,
        });
    }
    return out;
}

function moveEventToDone(filename: string, enriched: KnowledgeEvent): void {
    const donePath = path.join(DONE_DIR, filename);
    const pendingPath = path.join(PENDING_DIR, filename);
    fs.writeFileSync(donePath, JSON.stringify(enriched, null, 2), 'utf-8');
    try {
        fs.unlinkSync(pendingPath);
    } catch (err) {
        log.log(`failed to remove pending event ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function processOneEvent(filename: string): Promise<void> {
    const pendingPath = path.join(PENDING_DIR, filename);

    let event: KnowledgeEvent;
    try {
        const raw = fs.readFileSync(pendingPath, 'utf-8');
        const parsed = JSON.parse(raw);
        event = liveNote.KnowledgeEventSchema.parse(parsed);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.log(`event:${filename} — malformed, moving to done with error: ${msg}`);
        const stub: KnowledgeEvent = {
            id: filename.replace(/\.json$/, ''),
            source: 'unknown',
            type: 'unknown',
            createdAt: new Date().toISOString(),
            payload: '',
            processedAt: new Date().toISOString(),
            error: `Failed to parse: ${msg}`,
        };
        moveEventToDone(filename, stub);
        return;
    }

    log.log(`event:${event.id} — received source=${event.source} type=${event.type}`);

    const eligible = await listEventEligibleLiveNotes();
    const candidates = await findCandidates(event, eligible);

    if (candidates.length === 0) {
        log.log(`event:${event.id} — no candidates (${eligible.length} eligible note${eligible.length === 1 ? '' : 's'})`);
    } else {
        log.log(`event:${event.id} — dispatching to ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}: ${candidates.map(c => c.filePath).join(', ')}`);
    }

    const runIds: string[] = [];
    let processingError: string | undefined;
    let okCount = 0;
    let errCount = 0;

    // Sequential — preserves total ordering
    for (const candidate of candidates) {
        try {
            const result = await runLiveNoteAgent(candidate.filePath, 'event', event.payload);
            if (result.runId) runIds.push(result.runId);
            if (result.error) {
                errCount++;
            } else {
                okCount++;
            }
        } catch (err) {
            errCount++;
            const msg = err instanceof Error ? err.message : String(err);
            log.log(`event:${event.id} — candidate ${candidate.filePath} threw: ${msg}`);
            processingError = (processingError ? processingError + '; ' : '') + `${candidate.filePath}: ${msg}`;
        }
    }

    if (candidates.length > 0) {
        log.log(`event:${event.id} — processed ok=${okCount} errors=${errCount}`);
    }

    const enriched: KnowledgeEvent = {
        ...event,
        processedAt: new Date().toISOString(),
        candidateFilePaths: candidates.map(c => c.filePath),
        runIds,
        ...(processingError ? { error: processingError } : {}),
    };

    moveEventToDone(filename, enriched);
}

async function processPendingEvents(): Promise<void> {
    ensureDirs();

    let filenames: string[];
    try {
        filenames = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
    } catch (err) {
        log.log(`failed to read pending dir: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    if (filenames.length === 0) return;

    // FIFO: monotonic IDs are lexicographically sortable
    filenames.sort();

    if (filenames.length > 1) {
        log.log(`tick — ${filenames.length} pending events`);
    }

    for (const filename of filenames) {
        try {
            await processOneEvent(filename);
        } catch (err) {
            log.log(`event:${filename} — unhandled error: ${err instanceof Error ? err.message : String(err)}`);
            // Keep the loop alive — don't move file, will retry on next tick
        }
    }
}

export async function init(): Promise<void> {
    log.log(`starting, polling every ${POLL_INTERVAL_MS / 1000}s`);
    ensureDirs();

    await processPendingEvents();

    while (true) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
            await processPendingEvents();
        } catch (err) {
            log.log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
