import { generateObject } from 'ai';
import { liveNote, PrefixLogger } from '@x/shared';
import type { KnowledgeEvent } from '@x/shared/dist/live-note.js';
import { createProvider } from '../../models/models.js';
import { getDefaultModelAndProvider, getLiveNoteAgentModel, resolveProviderConfig } from '../../models/defaults.js';
import { captureLlmUsage } from '../../analytics/usage.js';

const log = new PrefixLogger('LiveNote:Routing');

const BATCH_SIZE = 20;

export interface ParsedLiveNote {
    filePath: string;
    objective: string;
    eventMatchCriteria: string;
}

const ROUTING_SYSTEM_PROMPT = `You are a routing classifier for a personal knowledge base.

You will receive an event (something that happened — an email, meeting, message, etc.) and a list of *live notes*. Each live note has:
- filePath: the path of the note file
- objective: the persistent intent of the note (what it should keep being / containing)
- matchCriteria: an explicit description of which kinds of incoming signals should wake this note

Your job is to identify which live notes MIGHT be relevant to this event.

Rules:
- Be LIBERAL in your selections. Include any note that is even moderately relevant.
- Prefer false positives over false negatives — it is much better to include a note that turns out to be irrelevant than to miss one that was relevant.
- Only exclude notes that are CLEARLY and OBVIOUSLY irrelevant to the event.
- Do not attempt to judge whether the event contains enough information to act on. That is handled by the live-note agent in a later stage.
- Return an empty list only if no notes are relevant at all.
- Return each candidate's filePath exactly as given.`;

async function resolveModel() {
    const modelId = await getLiveNoteAgentModel();
    const { provider } = await getDefaultModelAndProvider();
    const config = await resolveProviderConfig(provider);
    return {
        model: createProvider(config).languageModel(modelId),
        modelId,
        providerName: provider,
    };
}

function buildRoutingPrompt(event: KnowledgeEvent, batch: ParsedLiveNote[]): string {
    const noteList = batch
        .map((n, i) => `${i + 1}. filePath: ${n.filePath}\n   objective: ${n.objective}\n   matchCriteria: ${n.eventMatchCriteria}`)
        .join('\n\n');

    return `## Event

Source: ${event.source}
Type: ${event.type}
Time: ${event.createdAt}

${event.payload}

## Live notes

${noteList}`;
}

export async function findCandidates(
    event: KnowledgeEvent,
    allLiveNotes: ParsedLiveNote[],
): Promise<ParsedLiveNote[]> {
    // Short-circuit for targeted re-runs — skip LLM routing entirely
    if (event.targetFilePath) {
        const target = allLiveNotes.find(n => n.filePath === event.targetFilePath);
        return target ? [target] : [];
    }

    if (allLiveNotes.length === 0) {
        log.log(`event:${event.id} — no event-eligible live notes`);
        return [];
    }

    log.log(`event:${event.id} — routing against ${allLiveNotes.length} live note${allLiveNotes.length === 1 ? '' : 's'}`);

    const { model, modelId, providerName } = await resolveModel();
    const candidatePaths = new Set<string>();

    for (let i = 0; i < allLiveNotes.length; i += BATCH_SIZE) {
        const batch = allLiveNotes.slice(i, i + BATCH_SIZE);
        try {
            const result = await generateObject({
                model,
                system: ROUTING_SYSTEM_PROMPT,
                prompt: buildRoutingPrompt(event, batch),
                schema: liveNote.Pass1OutputSchema,
            });
            captureLlmUsage({
                useCase: 'live_note_agent',
                subUseCase: 'routing',
                model: modelId,
                provider: providerName,
                usage: result.usage,
            });
            for (const fp of result.object.filePaths) {
                candidatePaths.add(fp);
            }
        } catch (err) {
            log.log(`event:${event.id} — Pass1 batch ${Math.floor(i / BATCH_SIZE)} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const candidates = allLiveNotes.filter(n => candidatePaths.has(n.filePath));
    log.log(`event:${event.id} — Pass1 → ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}${candidates.length > 0 ? `: ${candidates.map(c => c.filePath).join(', ')}` : ''}`);
    return candidates;
}
