import z from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { WorkDir } from '../../config/config.js';
import { TrackSchema } from '@x/shared/dist/track.js';
import { TrackStateSchema } from './types.js';
import { withFileLock } from '../file-lock.js';
import { splitFrontmatter, joinFrontmatter } from '../../application/lib/parse-frontmatter.js';

const KNOWLEDGE_DIR = path.join(WorkDir, 'knowledge');

function absPath(filePath: string): string {
    return path.join(KNOWLEDGE_DIR, filePath);
}

// ---------------------------------------------------------------------------
// Track-array helpers (read/write the `track:` key in a parsed frontmatter)
// ---------------------------------------------------------------------------

function getTrackArray(fm: Record<string, unknown>): unknown[] {
    const raw = fm.track;
    return Array.isArray(raw) ? raw : [];
}

function setTrackArray(fm: Record<string, unknown>, tracks: unknown[]): Record<string, unknown> {
    const next = { ...fm };
    if (tracks.length === 0) {
        delete next.track;
    } else {
        next.track = tracks;
    }
    return next;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function fetchAll(filePath: string): Promise<z.infer<typeof TrackStateSchema>[]> {
    let content: string;
    try {
        content = await fs.readFile(absPath(filePath), 'utf-8');
    } catch {
        return [];
    }
    const { frontmatter } = splitFrontmatter(content);
    const tracks: z.infer<typeof TrackStateSchema>[] = [];
    for (const raw of getTrackArray(frontmatter)) {
        const result = TrackSchema.safeParse(raw);
        if (result.success) tracks.push({ track: result.data });
    }
    return tracks;
}

export async function fetch(filePath: string, id: string): Promise<z.infer<typeof TrackStateSchema> | null> {
    const all = await fetchAll(filePath);
    return all.find(t => t.track.id === id) ?? null;
}

export async function fetchYaml(filePath: string, id: string): Promise<string | null> {
    const t = await fetch(filePath, id);
    if (!t) return null;
    return stringifyYaml(t.track).trimEnd();
}

export async function readNoteBody(filePath: string): Promise<string> {
    let content: string;
    try {
        content = await fs.readFile(absPath(filePath), 'utf-8');
    } catch {
        return '';
    }
    return splitFrontmatter(content).body;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function findRawIndex(rawTracks: unknown[], id: string): number {
    return rawTracks.findIndex(
        (raw) => raw && typeof raw === 'object' && (raw as Record<string, unknown>).id === id,
    );
}

export async function updateTrack(
    filePath: string,
    id: string,
    updates: Partial<z.infer<typeof TrackSchema>>,
): Promise<void> {
    return withFileLock(absPath(filePath), async () => {
        const content = await fs.readFile(absPath(filePath), 'utf-8');
        const { frontmatter, body } = splitFrontmatter(content);
        const rawTracks = getTrackArray(frontmatter);
        const idx = findRawIndex(rawTracks, id);
        if (idx === -1) throw new Error(`Track ${id} not found in ${filePath}`);
        const next = [...rawTracks];
        next[idx] = { ...(rawTracks[idx] as Record<string, unknown>), ...updates };
        const nextFm = setTrackArray(frontmatter, next);
        await fs.writeFile(absPath(filePath), joinFrontmatter(nextFm, body), 'utf-8');
    });
}

export async function replaceTrackYaml(
    filePath: string,
    id: string,
    newYaml: string,
): Promise<void> {
    return withFileLock(absPath(filePath), async () => {
        const parsed = TrackSchema.safeParse(parseYaml(newYaml));
        if (!parsed.success) throw new Error(`Invalid track YAML: ${parsed.error.message}`);
        if (parsed.data.id !== id) {
            throw new Error(`id cannot be changed (was "${id}", got "${parsed.data.id}")`);
        }
        const content = await fs.readFile(absPath(filePath), 'utf-8');
        const { frontmatter, body } = splitFrontmatter(content);
        const rawTracks = getTrackArray(frontmatter);
        const idx = findRawIndex(rawTracks, id);
        if (idx === -1) throw new Error(`Track ${id} not found in ${filePath}`);
        const next = [...rawTracks];
        next[idx] = parsed.data;
        const nextFm = setTrackArray(frontmatter, next);
        await fs.writeFile(absPath(filePath), joinFrontmatter(nextFm, body), 'utf-8');
    });
}

export async function deleteTrack(filePath: string, id: string): Promise<void> {
    return withFileLock(absPath(filePath), async () => {
        const content = await fs.readFile(absPath(filePath), 'utf-8');
        const { frontmatter, body } = splitFrontmatter(content);
        const rawTracks = getTrackArray(frontmatter);
        const idx = findRawIndex(rawTracks, id);
        if (idx === -1) return; // already gone
        const next = [...rawTracks];
        next.splice(idx, 1);
        const nextFm = setTrackArray(frontmatter, next);
        await fs.writeFile(absPath(filePath), joinFrontmatter(nextFm, body), 'utf-8');
    });
}

/**
 * Replace the note's body. Frontmatter is preserved (including the `track:`
 * array). Used by the runner to commit the agent's body edits without granting
 * the agent write access to its own runtime state.
 */
export async function writeNoteBody(filePath: string, newBody: string): Promise<void> {
    return withFileLock(absPath(filePath), async () => {
        const content = await fs.readFile(absPath(filePath), 'utf-8');
        const { frontmatter } = splitFrontmatter(content);
        await fs.writeFile(absPath(filePath), joinFrontmatter(frontmatter, newBody), 'utf-8');
    });
}

// ---------------------------------------------------------------------------
// Note-level summaries (tracks-list view)
// ---------------------------------------------------------------------------

type TrackNoteSummary = {
    path: string;
    trackCount: number;
    createdAt: string | null;
    lastRunAt: string | null;
    isActive: boolean;
};

async function summarizeTrackNote(
    filePath: string,
    tracks: z.infer<typeof TrackStateSchema>[],
): Promise<TrackNoteSummary | null> {
    if (tracks.length === 0) return null;

    const stats = await fs.stat(absPath(filePath));
    const createdMs = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;

    let latestRunAt: string | null = null;
    let latestRunMs = -1;
    for (const { track } of tracks) {
        if (!track.lastRunAt) continue;
        const candidateMs = Date.parse(track.lastRunAt);
        if (Number.isNaN(candidateMs) || candidateMs <= latestRunMs) continue;
        latestRunMs = candidateMs;
        latestRunAt = track.lastRunAt;
    }

    return {
        path: `knowledge/${filePath}`,
        trackCount: tracks.length,
        createdAt: createdMs > 0 ? new Date(createdMs).toISOString() : null,
        lastRunAt: latestRunAt,
        isActive: tracks.every(({ track }) => track.active !== false),
    };
}

export async function listNotesWithTracks(): Promise<TrackNoteSummary[]> {
    async function walk(relativeDir = ''): Promise<string[]> {
        const dirPath = absPath(relativeDir);
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            const files: string[] = [];
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const childRelPath = relativeDir
                    ? path.posix.join(relativeDir, entry.name)
                    : entry.name;
                if (entry.isDirectory()) {
                    files.push(...await walk(childRelPath));
                    continue;
                }
                if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                    files.push(childRelPath);
                }
            }
            return files;
        } catch {
            return [];
        }
    }

    const markdownFiles = await walk();
    const notes = await Promise.all(markdownFiles.map(async (relativePath) => {
        try {
            const tracks = await fetchAll(relativePath);
            return await summarizeTrackNote(relativePath, tracks);
        } catch {
            return null;
        }
    }));

    return notes
        .filter((note): note is TrackNoteSummary => note !== null)
        .sort((a, b) => {
            const aName = path.basename(a.path, '.md').toLowerCase();
            const bName = path.basename(b.path, '.md').toLowerCase();
            if (aName !== bName) return aName.localeCompare(bName);
            return a.path.localeCompare(b.path);
        });
}

export async function setNoteTracksActive(
    filePath: string,
    active: boolean,
): Promise<TrackNoteSummary | null> {
    return withFileLock(absPath(filePath), async () => {
        const content = await fs.readFile(absPath(filePath), 'utf-8');
        const { frontmatter, body } = splitFrontmatter(content);
        const rawTracks = getTrackArray(frontmatter);
        if (rawTracks.length === 0) return null;

        const allMatch = rawTracks.every(
            (raw) => raw && typeof raw === 'object'
                && ((raw as Record<string, unknown>).active !== false) === active,
        );
        if (!allMatch) {
            const updated = rawTracks.map((raw) =>
                raw && typeof raw === 'object'
                    ? { ...(raw as Record<string, unknown>), active }
                    : raw,
            );
            const nextFm = setTrackArray(frontmatter, updated);
            await fs.writeFile(absPath(filePath), joinFrontmatter(nextFm, body), 'utf-8');
        }

        const validated = await fetchAll(filePath);
        return summarizeTrackNote(filePath, validated);
    });
}
