import { useCallback, useEffect, useMemo, useState } from 'react'
import '@/styles/live-note-panel.css'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import {
  Radio, Clock, Play, Square, Loader2, Sparkles, CalendarClock, Zap,
  Trash2, AlertCircle, ChevronDown, ChevronUp, Plus, X, Save,
} from 'lucide-react'
import { LiveNoteSchema, type LiveNote, type Triggers } from '@x/shared/dist/live-note.js'
import { useLiveNoteAgentStatus } from '@/hooks/use-live-note-agent-status'
import { formatRelativeTime } from '@/lib/relative-time'

export type OpenLiveNotePanelDetail = {
  filePath: string
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
}

function describeCron(expr: string): string {
  return CRON_PHRASES[expr.trim()] ?? expr
}

function summarizeTriggers(live: LiveNote): { icon: 'timer' | 'calendar' | 'bolt'; text: string } {
  const t = live.triggers
  if (!t) return { icon: 'bolt', text: 'Manual only' }
  const parts: string[] = []
  if (t.cronExpr) parts.push(describeCron(t.cronExpr))
  if (t.windows && t.windows.length > 0) {
    parts.push(t.windows.length === 1
      ? `${t.windows[0].startTime}–${t.windows[0].endTime}`
      : `${t.windows.length} windows`)
  }
  if (t.eventMatchCriteria) parts.push('event-driven')
  if (parts.length === 0) return { icon: 'bolt', text: 'Manual only' }
  const icon = t.cronExpr ? 'timer' : t.windows?.length ? 'calendar' : 'bolt'
  return { icon, text: parts.join(' · ') }
}

function ScheduleIcon({ icon, size = 14 }: { icon: 'timer' | 'calendar' | 'bolt'; size?: number }) {
  if (icon === 'timer') return <Clock size={size} />
  if (icon === 'calendar') return <CalendarClock size={size} />
  return <Zap size={size} />
}

function stripKnowledgePrefix(p: string): string {
  return p.replace(/^knowledge\//, '')
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/

export interface LiveNoteSidebarProps {
  /**
   * Note path the panel should bind to. Workspace-relative (`knowledge/Foo.md`)
   * or full — both forms are accepted; the prefix is stripped internally.
   * `null` (or empty) hides the panel entirely.
   */
  filePath: string | null
  /** Called when the user clicks the close button or hands off to Copilot. */
  onClose: () => void
}

export function LiveNoteSidebar({ filePath, onClose }: LiveNoteSidebarProps) {
  const [live, setLive] = useState<LiveNote | null>(null)
  const [draft, setDraft] = useState<LiveNote | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const knowledgeRelPath = useMemo(() => stripKnowledgePrefix(filePath ?? ''), [filePath])
  const agentStatus = useLiveNoteAgentStatus()
  const runState = agentStatus.get(knowledgeRelPath) ?? { status: 'idle' as const }
  const isRunning = runState.status === 'running'

  const refresh = useCallback(async (relPath: string) => {
    if (!relPath) { setLive(null); setDraft(null); return }
    setLoading(true)
    setError(null)
    try {
      const res = await window.ipc.invoke('live-note:get', { filePath: relPath })
      if (!res.success) {
        setError(res.error ?? 'Failed to load')
        setLive(null)
        setDraft(null)
        return
      }
      setLive(res.live ?? null)
      setDraft(res.live ? structuredClone(res.live) as LiveNote : null)
      setConfirmingDelete(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLive(null)
      setDraft(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Reset transient panel state and reload data whenever the bound path changes.
  useEffect(() => {
    setShowAdvanced(false)
    setConfirmingDelete(false)
    setError(null)
    if (knowledgeRelPath) {
      void refresh(knowledgeRelPath)
    } else {
      setLive(null)
      setDraft(null)
    }
  }, [knowledgeRelPath, refresh])

  // Re-fetch when a run completes for this file.
  useEffect(() => {
    if (!knowledgeRelPath) return
    const state = agentStatus.get(knowledgeRelPath)
    if (state && (state.status === 'done' || state.status === 'error')) {
      void refresh(knowledgeRelPath)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentStatus, knowledgeRelPath])

  const isDirty = useMemo(() => {
    if (!live || !draft) return false
    return JSON.stringify(live) !== JSON.stringify(draft)
  }, [live, draft])

  const handleSave = useCallback(async () => {
    if (!knowledgeRelPath || !draft) return
    const parsed = LiveNoteSchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues.map(i => i.message).join('; '))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await window.ipc.invoke('live-note:set', { filePath: knowledgeRelPath, live: parsed.data })
      if (!res.success) {
        setError(res.error ?? 'Save failed')
        return
      }
      setLive(res.live ?? null)
      setDraft(res.live ? structuredClone(res.live) as LiveNote : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [knowledgeRelPath, draft])

  const handleToggleActive = useCallback(async () => {
    if (!knowledgeRelPath || !live) return
    setSaving(true)
    setError(null)
    try {
      const res = await window.ipc.invoke('live-note:setActive', {
        filePath: knowledgeRelPath,
        active: live.active === false,
      })
      if (!res.success) {
        setError(res.error ?? 'Failed')
        return
      }
      setLive(res.live ?? null)
      setDraft(res.live ? structuredClone(res.live) as LiveNote : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [knowledgeRelPath, live])

  const handleRun = useCallback(async () => {
    if (!knowledgeRelPath) return
    setError(null)
    try {
      await window.ipc.invoke('live-note:run', { filePath: knowledgeRelPath })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [knowledgeRelPath])

  const handleStop = useCallback(async () => {
    if (!knowledgeRelPath) return
    setError(null)
    try {
      const res = await window.ipc.invoke('live-note:stop', { filePath: knowledgeRelPath })
      if (!res.success && res.error) setError(res.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [knowledgeRelPath])

  const handleDelete = useCallback(async () => {
    if (!knowledgeRelPath) return
    setSaving(true)
    setError(null)
    try {
      const res = await window.ipc.invoke('live-note:delete', { filePath: knowledgeRelPath })
      if (!res.success) {
        setError(res.error ?? 'Delete failed')
        return
      }
      setLive(null)
      setDraft(null)
      setConfirmingDelete(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [knowledgeRelPath])

  const handleEditWithCopilot = useCallback(() => {
    if (!filePath) return
    window.dispatchEvent(new CustomEvent('rowboat:open-copilot-edit-live-note', {
      detail: { filePath },
    }))
    onClose()
  }, [filePath, onClose])

  const handleMakeLive = useCallback(() => {
    // Empty-state CTA: hand off to Copilot for the natural-language flow.
    handleEditWithCopilot()
  }, [handleEditWithCopilot])

  if (!filePath) return null

  const noteTitle = filePath
    ? (filePath.split('/').pop() ?? filePath).replace(/\.md$/, '')
    : 'Live note'
  const sched = live ? summarizeTriggers(live) : null
  const paused = live?.active === false

  return (
    <aside className="flex w-[420px] max-w-[40vw] shrink-0 flex-col overflow-hidden border-l border-border bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-3 text-sidebar-foreground">
        <Radio className="size-4 shrink-0 text-sidebar-foreground/70" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">Live note</span>
          <span className="truncate text-xs text-sidebar-foreground/60">{noteTitle}</span>
        </div>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={onClose}
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

      {loading && (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Loading…
        </div>
      )}

      {!loading && !live && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          <Radio className="size-8 text-muted-foreground/50" />
          <div className="text-sm font-medium text-foreground">This note is passive</div>
          <div className="text-xs text-muted-foreground max-w-[260px]">
            Make it live to have an agent keep its body up to date — describe what you want it to track and how often.
          </div>
          <Button size="sm" onClick={handleMakeLive} className="mt-2">
            <Sparkles className="size-3" />
            Make this note live
          </Button>
        </div>
      )}

      {!loading && live && draft && sched && (
        <div className={`flex flex-1 flex-col overflow-hidden ${paused ? 'opacity-80' : ''}`}>
          {/* Status row: schedule summary + active toggle. */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
              <ScheduleIcon icon={sched.icon} />
              <span className="truncate">
                {paused ? `Paused · ${sched.text}` : sched.text}
              </span>
            </span>
            <label className="flex shrink-0 items-center gap-2">
              <Switch
                checked={!paused}
                onCheckedChange={handleToggleActive}
                disabled={saving}
              />
              <span className="text-xs text-muted-foreground">{paused ? 'Paused' : 'Active'}</span>
            </label>
          </div>

          {/* Persistent error banner — shows lastRunError until the next successful run. */}
          {!isRunning && live.lastRunError && (
            <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  Last run failed{live.lastAttemptAt ? ` · ${formatRelativeTime(live.lastAttemptAt)}` : ''}
                </div>
                <div className="break-words text-amber-700/90 dark:text-amber-300/90">{live.lastRunError}</div>
              </div>
            </div>
          )}

          {/* Body */}
          <div className="flex-1 overflow-auto px-3 py-3 space-y-4">
            {/* Objective */}
            <Section label="Objective" hint="What this note should keep being.">
              <Textarea
                value={draft.objective}
                onChange={(e) => setDraft({ ...draft, objective: e.target.value })}
                rows={6}
                spellCheck
                placeholder="Keep this note updated with…"
                className="font-sans text-sm"
              />
            </Section>

            {/* Triggers */}
            <Section label="Triggers" hint="When the agent fires. Mix freely; absent fields just don't fire.">
              <TriggersEditor draft={draft} setDraft={setDraft} />
            </Section>

            {/* Status */}
            {(live.lastRunAt || live.lastRunSummary) && (
              <Section label="Last run">
                <DetailGrid>
                  {live.lastRunAt && <DetailRow label="At" value={formatDateTime(live.lastRunAt)} />}
                  {live.lastRunSummary && <DetailRow label="Summary" value={live.lastRunSummary} />}
                </DetailGrid>
              </Section>
            )}

            {/* Advanced (model + provider + danger zone) */}
            <div className="border-t border-border pt-3">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowAdvanced(s => !s)}
              >
                {showAdvanced ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                Advanced (model · provider · danger zone)
              </button>
              {showAdvanced && (
                <div className="mt-2 space-y-3">
                  <LabeledField label="Model">
                    <Input
                      value={draft.model ?? ''}
                      onChange={(e) => setDraft({ ...draft, model: e.target.value || undefined })}
                      placeholder="(use global default)"
                      className="font-mono text-xs"
                    />
                  </LabeledField>
                  <LabeledField label="Provider">
                    <Input
                      value={draft.provider ?? ''}
                      onChange={(e) => setDraft({ ...draft, provider: e.target.value || undefined })}
                      placeholder="(use global default)"
                      className="font-mono text-xs"
                    />
                  </LabeledField>
                  <div className="border-t border-border pt-3">
                    {confirmingDelete ? (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
                        <span className="text-destructive">Make this note passive?</span>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(false)} disabled={saving}>
                            Cancel
                          </Button>
                          <Button variant="destructive" size="sm" onClick={handleDelete} disabled={saving}>
                            {saving ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                            Make passive
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
                        Make passive
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer — pulsing "Updating…" pill on the left when running */}
          <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/20 px-3 py-2.5">
            {isRunning && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-foreground animate-pulse">
                <Loader2 className="size-3 animate-spin" />
                Updating…
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleEditWithCopilot} disabled={saving || isRunning}>
                <Sparkles className="size-3" />
                Edit with Copilot
              </Button>
              {isDirty && !isRunning && (
                <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                  Save
                </Button>
              )}
              {isRunning ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleStop}
                  disabled={saving}
                >
                  <Square className="size-3" />
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleRun}
                  disabled={saving}
                >
                  <Play className="size-3" />
                  Run now
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

function Section({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div>{children}</div>
    </div>
  )
}

function TriggersEditor({
  draft,
  setDraft,
}: {
  draft: LiveNote
  setDraft: (next: LiveNote) => void
}) {
  const triggers: Triggers = draft.triggers ?? {}
  const hasCron = typeof triggers.cronExpr === 'string'
  const hasWindows = Array.isArray(triggers.windows)
  const hasEvent = typeof triggers.eventMatchCriteria === 'string'

  const updateTriggers = (next: Partial<Triggers>) => {
    const merged: Triggers = { ...triggers, ...next }
    // Strip undefined
    ;(Object.keys(merged) as (keyof Triggers)[]).forEach(key => {
      if (merged[key] === undefined) delete merged[key]
    })
    if (Object.keys(merged).length === 0) {
      const { triggers: _omit, ...rest } = draft
      setDraft(rest as LiveNote)
    } else {
      setDraft({ ...draft, triggers: merged })
    }
  }

  return (
    <div className="space-y-3">
      {/* cronExpr */}
      <TriggerRow
        present={hasCron}
        label="Cron"
        onAdd={() => updateTriggers({ cronExpr: '0 * * * *' })}
        onRemove={() => updateTriggers({ cronExpr: undefined })}
      >
        {hasCron && (
          <Input
            value={triggers.cronExpr ?? ''}
            onChange={(e) => updateTriggers({ cronExpr: e.target.value })}
            placeholder='"0 * * * *"'
            className="font-mono text-xs"
          />
        )}
        {hasCron && triggers.cronExpr && (
          <div className="text-[10px] text-muted-foreground">{describeCron(triggers.cronExpr)}</div>
        )}
      </TriggerRow>

      {/* windows */}
      <TriggerRow
        present={hasWindows}
        label="Windows"
        onAdd={() => updateTriggers({ windows: [{ startTime: '09:00', endTime: '12:00' }] })}
        onRemove={() => updateTriggers({ windows: undefined })}
      >
        {triggers.windows && (
          <div className="space-y-1.5">
            {triggers.windows.map((w, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <Input
                  value={w.startTime}
                  onChange={(e) => {
                    const next = [...(triggers.windows ?? [])]
                    next[idx] = { ...next[idx], startTime: e.target.value }
                    updateTriggers({ windows: next })
                  }}
                  placeholder="09:00"
                  className={`h-7 w-20 font-mono text-xs ${HH_MM.test(w.startTime) ? '' : 'border-destructive'}`}
                />
                <span className="text-xs text-muted-foreground">–</span>
                <Input
                  value={w.endTime}
                  onChange={(e) => {
                    const next = [...(triggers.windows ?? [])]
                    next[idx] = { ...next[idx], endTime: e.target.value }
                    updateTriggers({ windows: next })
                  }}
                  placeholder="12:00"
                  className={`h-7 w-20 font-mono text-xs ${HH_MM.test(w.endTime) ? '' : 'border-destructive'}`}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = (triggers.windows ?? []).filter((_, i) => i !== idx)
                    updateTriggers({ windows: next.length === 0 ? undefined : next })
                  }}
                  className="ml-1 inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Remove window"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => updateTriggers({
                windows: [...(triggers.windows ?? []), { startTime: '13:00', endTime: '15:00' }],
              })}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-3" /> Add window
            </button>
          </div>
        )}
      </TriggerRow>

      {/* eventMatchCriteria */}
      <TriggerRow
        present={hasEvent}
        label="Events"
        onAdd={() => updateTriggers({ eventMatchCriteria: '' })}
        onRemove={() => updateTriggers({ eventMatchCriteria: undefined })}
      >
        {hasEvent && (
          <Textarea
            value={triggers.eventMatchCriteria ?? ''}
            onChange={(e) => updateTriggers({ eventMatchCriteria: e.target.value })}
            rows={3}
            placeholder="Emails or calendar events about…"
            className="text-xs"
          />
        )}
      </TriggerRow>
    </div>
  )
}

function TriggerRow({
  present,
  label,
  onAdd,
  onRemove,
  children,
}: {
  present: boolean
  label: string
  onAdd: () => void
  onRemove: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        {present ? (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Remove ${label}`}
          >
            <X className="size-3" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3" /> Add
          </button>
        )}
      </div>
      {present && children && <div className="mt-2 space-y-1">{children}</div>}
    </div>
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
