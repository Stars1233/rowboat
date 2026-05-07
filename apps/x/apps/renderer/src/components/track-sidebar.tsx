import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import '@/styles/track-modal.css'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Radio, Clock, Play, Loader2, Sparkles, Code2, CalendarClock, Zap,
  Trash2, ChevronDown, ChevronUp, ChevronLeft, X,
} from 'lucide-react'
import { parse as parseYaml } from 'yaml'
import { Streamdown } from 'streamdown'
import { TrackSchema, type Trigger } from '@x/shared/dist/track.js'
import { useTrackStatus } from '@/hooks/use-track-status'

export type OpenTrackSidebarDetail = {
  filePath: string
  selectId?: string
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

const CRON_PHRASES: Record<string, string> = {
  '* * * * *': 'Every minute',
  '*/5 * * * *': 'Every 5 minutes',
  '*/15 * * * *': 'Every 15 minutes',
  '*/30 * * * *': 'Every 30 minutes',
  '0 * * * *': 'Hourly',
  '0 */2 * * *': 'Every 2 hours',
  '0 */6 * * *': 'Every 6 hours',
  '0 */12 * * *': 'Every 12 hours',
  '0 0 * * *': 'Daily at midnight',
  '0 8 * * *': 'Daily at 8 AM',
  '0 9 * * *': 'Daily at 9 AM',
  '0 12 * * *': 'Daily at noon',
  '0 18 * * *': 'Daily at 6 PM',
  '0 9 * * 1-5': 'Weekdays at 9 AM',
  '0 17 * * 1-5': 'Weekdays at 5 PM',
  '0 0 * * 0': 'Sundays at midnight',
  '0 0 * * 1': 'Mondays at midnight',
  '0 0 1 * *': 'First of each month',
}

function describeCron(expr: string): string {
  return CRON_PHRASES[expr.trim()] ?? expr
}

type ScheduleIconKind = 'timer' | 'calendar' | 'target' | 'bolt'
type ScheduleSummary = { icon: ScheduleIconKind; text: string }

function describeTrigger(t: Trigger): ScheduleSummary {
  if (t.type === 'once') return { icon: 'target', text: `Once at ${formatDateTime(t.runAt)}` }
  if (t.type === 'cron') return { icon: 'timer', text: describeCron(t.expression) }
  if (t.type === 'window') return { icon: 'calendar', text: `${t.startTime}–${t.endTime}` }
  return { icon: 'bolt', text: 'Event-driven' }
}

function summarizeTriggers(triggers: Trigger[] | undefined): ScheduleSummary {
  if (!triggers || triggers.length === 0) return { icon: 'bolt', text: 'Manual only' }
  const timed = triggers.filter(t => t.type !== 'event')
  const events = triggers.filter(t => t.type === 'event')
  if (timed.length === 0) {
    return { icon: 'bolt', text: events.length > 1 ? `${events.length} event triggers` : 'Event-driven' }
  }
  const first = describeTrigger(timed[0])
  let text = first.text
  if (timed.length > 1) text += ` (+${timed.length - 1})`
  if (events.length > 0) text += ' · also event-driven'
  return { icon: first.icon, text }
}


function ScheduleIcon({ icon, size = 14 }: { icon: ScheduleIconKind; size?: number }) {
  if (icon === 'timer') return <Clock size={size} />
  if (icon === 'calendar' || icon === 'target') return <CalendarClock size={size} />
  return <Zap size={size} />
}

function stripKnowledgePrefix(p: string): string {
  return p.replace(/^knowledge\//, '')
}

type Track = z.infer<typeof TrackSchema>

function parseTracksFromFile(content: string): Track[] {
  if (!content.startsWith('---')) return []
  const close = /\r?\n---\r?\n/.exec(content)
  if (!close) return []
  const yamlText = content.slice(3, close.index).trim()
  if (!yamlText) return []
  let fm: unknown
  try { fm = parseYaml(yamlText) } catch { return [] }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return []
  const raw = (fm as Record<string, unknown>).track
  if (!Array.isArray(raw)) return []
  const tracks: Track[] = []
  for (const entry of raw) {
    const result = TrackSchema.safeParse(entry)
    if (result.success) tracks.push(result.data)
  }
  return tracks
}

type Tab = 'what' | 'when' | 'event' | 'details'

export function TrackSidebar() {
  const [open, setOpen] = useState(false)
  const [filePath, setFilePath] = useState<string>('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Detail-view state (per-track local UI)
  const [activeTab, setActiveTab] = useState<Tab>('what')
  const [editingRaw, setEditingRaw] = useState(false)
  const [rawDraft, setRawDraft] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const knowledgeRelPath = useMemo(() => stripKnowledgePrefix(filePath), [filePath])
  const allTrackStatus = useTrackStatus()

  const refresh = useCallback(async (relPath: string) => {
    if (!relPath) { setTracks([]); return }
    setLoading(true)
    setError(null)
    try {
      const res = await window.ipc.invoke('workspace:readFile', { path: `knowledge/${relPath}` })
      if (res?.data) {
        setTracks(parseTracksFromFile(res.data))
      } else {
        setTracks([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setTracks([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<OpenTrackSidebarDetail>
      const d = ev.detail
      if (!d?.filePath) return
      setFilePath(d.filePath)
      setSelectedId(d.selectId ?? null)
      setActiveTab('what')
      setEditingRaw(false)
      setRawDraft('')
      setShowAdvanced(false)
      setConfirmingDelete(false)
      setError(null)
      setOpen(true)
      void refresh(stripKnowledgePrefix(d.filePath))
    }
    window.addEventListener('rowboat:open-track-sidebar', handler as EventListener)
    return () => window.removeEventListener('rowboat:open-track-sidebar', handler as EventListener)
  }, [refresh])

  // Re-fetch when a run completes for a track in this file.
  useEffect(() => {
    if (!open || !knowledgeRelPath) return
    let stale = false
    for (const [, state] of allTrackStatus) {
      if (state.status === 'done' || state.status === 'error') {
        stale = true
        break
      }
    }
    if (stale) void refresh(knowledgeRelPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTrackStatus, open, knowledgeRelPath])

  const selected = useMemo(
    () => (selectedId ? tracks.find(t => t.id === selectedId) ?? null : null),
    [selectedId, tracks],
  )

  // Seed raw editor draft when entering advanced mode.
  useEffect(() => {
    if (showAdvanced && selected) {
      try {
        // Lazy import yaml stringify only when needed; avoid top-level dep cycle.
        import('yaml').then(({ stringify }) => {
          setRawDraft(stringify(selected).trimEnd())
        })
      } catch {
        setRawDraft('')
      }
    }
  }, [showAdvanced, selected])

  useEffect(() => {
    if (editingRaw && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.setSelectionRange(
        textareaRef.current.value.length,
        textareaRef.current.value.length,
      )
    }
  }, [editingRaw])

  const runUpdate = useCallback(async (id: string, updates: Record<string, unknown>) => {
    if (!knowledgeRelPath) return
    setSaving(true)
    setError(null)
    try {
      const res = await window.ipc.invoke('track:update', { id, filePath: knowledgeRelPath, updates })
      if (!res?.success && res?.error) setError(res.error)
      await refresh(knowledgeRelPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [knowledgeRelPath, refresh])

  const handleToggleActive = useCallback((id: string, currentlyActive: boolean) => {
    void runUpdate(id, { active: !currentlyActive })
  }, [runUpdate])

  const handleRun = useCallback(async (id: string) => {
    if (!knowledgeRelPath) return
    try {
      await window.ipc.invoke('track:run', { id, filePath: knowledgeRelPath })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [knowledgeRelPath])

  const handleSaveRaw = useCallback(async () => {
    if (!knowledgeRelPath || !selectedId) return
    setSaving(true)
    setError(null)
    try {
      const res = await window.ipc.invoke('track:replaceYaml', { id: selectedId, filePath: knowledgeRelPath, yaml: rawDraft })
      if (res?.success) {
        setEditingRaw(false)
        await refresh(knowledgeRelPath)
      } else if (res?.error) {
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [knowledgeRelPath, selectedId, rawDraft, refresh])

  const handleDelete = useCallback(async () => {
    if (!knowledgeRelPath || !selectedId) return
    setSaving(true)
    setError(null)
    try {
      const res = await window.ipc.invoke('track:delete', { id: selectedId, filePath: knowledgeRelPath })
      if (res?.success) {
        setSelectedId(null)
        setConfirmingDelete(false)
        await refresh(knowledgeRelPath)
      } else if (res?.error) {
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [knowledgeRelPath, selectedId, refresh])

  const handleEditWithCopilot = useCallback(() => {
    if (!filePath || !selectedId) return
    window.dispatchEvent(new CustomEvent('rowboat:open-copilot-edit-track', {
      detail: { trackId: selectedId, filePath },
    }))
    setOpen(false)
  }, [filePath, selectedId])

  if (!open) return null

  const noteTitle = filePath
    ? (filePath.split('/').pop() ?? filePath).replace(/\.md$/, '')
    : 'Tracks'

  return (
    <aside className="fixed inset-y-0 right-0 z-60 flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden border-l border-border bg-background shadow-2xl">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-3 text-sidebar-foreground">
        <Radio className="size-4 shrink-0 text-sidebar-foreground/70" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">Tracks</span>
          <span className="truncate text-xs text-sidebar-foreground/60">{noteTitle}</span>
        </div>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={() => setOpen(false)}
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {!selected && (
        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Loading…
            </div>
          )}
          {!loading && tracks.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
              <Radio className="size-6 text-muted-foreground/50" />
              <div className="text-sm text-muted-foreground">No tracks in this note yet.</div>
              <div className="text-xs text-muted-foreground/70">
                Ask Copilot &ldquo;track Chicago time hourly&rdquo; to add one.
              </div>
            </div>
          )}
          <ul className="divide-y divide-border">
            {tracks.map(t => {
              const sched = summarizeTriggers(t.triggers)
              const runState = allTrackStatus.get(`${t.id}:${knowledgeRelPath}`) ?? { status: 'idle' as const }
              const isRunning = runState.status === 'running'
              const paused = t.active === false
              const instructionPreview = t.instruction.split('\n')[0].trim()
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent ${paused ? 'opacity-60' : ''}`}
                    onClick={() => { setSelectedId(t.id); setActiveTab('what') }}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{t.id}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {paused ? 'Paused · ' : ''}{sched.text}
                      </span>
                      {instructionPreview && (
                        <span className="truncate text-xs text-muted-foreground/70">
                          {instructionPreview}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-background hover:text-foreground ${isRunning ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                      onClick={(ev) => { ev.stopPropagation(); void handleRun(t.id) }}
                      disabled={isRunning}
                      aria-label={isRunning ? `Running ${t.id}` : `Run ${t.id}`}
                      title={isRunning ? `Running…` : `Run ${t.id}`}
                    >
                      {isRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    </button>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {selected && (() => {
        const triggers: Trigger[] = selected.triggers ?? []
        const timedTriggers = triggers.filter((t): t is Exclude<Trigger, { type: 'event' }> => t.type !== 'event')
        const eventTriggers = triggers.filter((t): t is Extract<Trigger, { type: 'event' }> => t.type === 'event')
        const sched = summarizeTriggers(triggers)
        const runState = allTrackStatus.get(`${selected.id}:${knowledgeRelPath}`) ?? { status: 'idle' as const }
        const isRunning = runState.status === 'running'
        const paused = selected.active === false
        const visibleTabs: { key: Tab; label: string; visible: boolean }[] = [
          { key: 'what', label: 'What', visible: true },
          { key: 'when', label: 'Schedule', visible: timedTriggers.length > 0 },
          { key: 'event', label: 'Events', visible: eventTriggers.length > 0 },
          { key: 'details', label: 'Details', visible: true },
        ]
        const shown = visibleTabs.filter(t => t.visible)

        return (
          <div className={`flex flex-1 flex-col overflow-hidden ${paused ? 'opacity-80' : ''}`}>
            {/* Subheader: back arrow + track id */}
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2">
              <button
                type="button"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => {
                  setSelectedId(null)
                  setShowAdvanced(false)
                  setEditingRaw(false)
                  setConfirmingDelete(false)
                }}
                aria-label="Back to tracks"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="truncate text-sm font-medium">{selected.id}</span>
            </div>

            {/* Status row: schedule summary + active toggle */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
              <span className="truncate text-xs text-muted-foreground">{sched.text}</span>
              <label className="flex shrink-0 items-center gap-2">
                <Switch
                  checked={!paused}
                  onCheckedChange={() => handleToggleActive(selected.id, !paused)}
                  disabled={saving}
                />
                <span className="text-xs text-muted-foreground">{paused ? 'Paused' : 'Active'}</span>
              </label>
            </div>

            {/* Tabs */}
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
              {shown.map(tab => (
                <button
                  key={tab.key}
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    activeTab === tab.key
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`}
                  onClick={() => { setActiveTab(tab.key); setEditingRaw(false) }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-auto px-3 py-3">
              {activeTab === 'what' && (
                <div className="text-sm leading-relaxed">
                  {selected.instruction ? (
                    <Streamdown className="prose prose-sm max-w-none dark:prose-invert">
                      {selected.instruction}
                    </Streamdown>
                  ) : (
                    <span className="text-muted-foreground">No instruction set.</span>
                  )}
                </div>
              )}

              {activeTab === 'when' && timedTriggers.length > 0 && (
                <div className="flex flex-col gap-2">
                  {timedTriggers.map((trig, idx) => {
                    const tSched = describeTrigger(trig)
                    return (
                      <div key={idx} className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
                        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                          <ScheduleIcon icon={tSched.icon} size={14} />
                          <span>{tSched.text}</span>
                        </div>
                        <DetailGrid>
                          <DetailRow label="Type" value={<code className="rounded bg-muted px-1 py-0.5 text-[11px]">{trig.type}</code>} />
                          {trig.type === 'cron' && (
                            <DetailRow label="Expression" value={<code className="rounded bg-muted px-1 py-0.5 text-[11px]">{trig.expression}</code>} />
                          )}
                          {trig.type === 'window' && (
                            <DetailRow label="Window" value={`${trig.startTime} – ${trig.endTime}`} />
                          )}
                          {trig.type === 'once' && (
                            <DetailRow label="Runs at" value={formatDateTime(trig.runAt)} />
                          )}
                        </DetailGrid>
                      </div>
                    )
                  })}
                </div>
              )}

              {activeTab === 'event' && (
                <div className="flex flex-col gap-2">
                  {eventTriggers.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No event matching set.</span>
                  ) : eventTriggers.map((trig, idx) => (
                    <div key={idx} className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
                      <Streamdown className="prose prose-sm max-w-none dark:prose-invert">
                        {trig.matchCriteria}
                      </Streamdown>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'details' && (
                <DetailGrid>
                  <DetailRow label="ID" value={<code className="rounded bg-muted px-1 py-0.5 text-[11px]">{selected.id}</code>} />
                  <DetailRow label="File" value={<code className="rounded bg-muted px-1 py-0.5 text-[11px] break-all">{filePath}</code>} />
                  <DetailRow label="Status" value={paused ? 'Paused' : 'Active'} />
                  {selected.model && <DetailRow label="Model" value={<code className="rounded bg-muted px-1 py-0.5 text-[11px]">{selected.model}</code>} />}
                  {selected.provider && <DetailRow label="Provider" value={<code className="rounded bg-muted px-1 py-0.5 text-[11px]">{selected.provider}</code>} />}
                  {selected.lastRunAt && <DetailRow label="Last run" value={formatDateTime(selected.lastRunAt)} />}
                  {selected.lastRunSummary && <DetailRow label="Summary" value={selected.lastRunSummary} />}
                </DetailGrid>
              )}

              {/* Advanced — raw YAML */}
              <div className="mt-6 border-t border-border pt-3">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    const next = !showAdvanced
                    setShowAdvanced(next)
                    setEditingRaw(next)
                  }}
                >
                  {showAdvanced ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                  <Code2 className="size-3" />
                  Advanced (raw YAML)
                </button>
                {showAdvanced && (
                  <div className="mt-2 flex flex-col gap-2">
                    <Textarea
                      ref={textareaRef}
                      value={rawDraft}
                      onChange={(e) => setRawDraft(e.target.value)}
                      rows={12}
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setShowAdvanced(false); setEditingRaw(false) }}
                        disabled={saving}
                      >
                        Cancel
                      </Button>
                      <Button size="sm" onClick={handleSaveRaw} disabled={saving}>
                        {saving ? <Loader2 className="size-3 animate-spin" /> : null}
                        Save
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Danger zone — Details tab only */}
              {activeTab === 'details' && (
                <div className="mt-4 border-t border-border pt-3">
                  {confirmingDelete ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
                      <span className="text-destructive">Delete this track?</span>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(false)} disabled={saving}>
                          Cancel
                        </Button>
                        <Button variant="destructive" size="sm" onClick={handleDelete} disabled={saving}>
                          {saving ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                          Delete
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setConfirmingDelete(true)}
                    >
                      <Trash2 className="size-3" />
                      Delete track
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/20 px-3 py-2.5">
              <Button variant="outline" size="sm" onClick={handleEditWithCopilot} disabled={saving}>
                <Sparkles className="size-3" />
                Edit with Copilot
              </Button>
              <Button
                size="sm"
                onClick={() => handleRun(selected.id)}
                disabled={isRunning || saving}
              >
                {isRunning ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                {isRunning ? 'Running…' : 'Run now'}
              </Button>
            </div>
          </div>
        )
      })()}
    </aside>
  )
}

function DetailGrid({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
      {children}
    </dl>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{value}</dd>
    </>
  )
}
