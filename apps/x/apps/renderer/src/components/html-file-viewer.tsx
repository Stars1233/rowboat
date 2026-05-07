import { useEffect, useState } from 'react'
import { AlertCircleIcon, ExternalLinkIcon, FileTextIcon, Loader2Icon } from 'lucide-react'

const MAX_SIZE_BYTES = 5 * 1024 * 1024
const CACHE_MAX_ENTRIES = 20

type CacheEntry = { html: string; mtimeMs: number; size: number }
const htmlCache = new Map<string, CacheEntry>()

function getCached(path: string, mtimeMs: number, size: number): string | null {
  const entry = htmlCache.get(path)
  if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) return null
  // Refresh LRU position
  htmlCache.delete(path)
  htmlCache.set(path, entry)
  return entry.html
}

function setCached(path: string, html: string, mtimeMs: number, size: number) {
  htmlCache.set(path, { html, mtimeMs, size })
  while (htmlCache.size > CACHE_MAX_ENTRIES) {
    const oldest = htmlCache.keys().next().value
    if (oldest === undefined) break
    htmlCache.delete(oldest)
  }
}

type ViewerState =
  | { kind: 'loading' }
  | { kind: 'loaded'; html: string }
  | { kind: 'empty' }
  | { kind: 'tooLarge'; sizeMB: number }
  | { kind: 'error'; message: string }

interface HtmlFileViewerProps {
  path: string
}

export function HtmlFileViewer({ path }: HtmlFileViewerProps) {
  const [state, setState] = useState<ViewerState>({ kind: 'loading' })
  const [iframeLoaded, setIframeLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    setIframeLoaded(false)

    ;(async () => {
      try {
        const stat = await window.ipc.invoke('workspace:stat', { path })
        if (cancelled) return
        if (stat.kind !== 'file') {
          setState({ kind: 'error', message: 'Selected path is not a file.' })
          return
        }
        if (stat.size > MAX_SIZE_BYTES) {
          setState({ kind: 'tooLarge', sizeMB: stat.size / (1024 * 1024) })
          return
        }
        const cachedHtml = getCached(path, stat.mtimeMs, stat.size)
        if (cachedHtml !== null) {
          setState(cachedHtml.trim() === '' ? { kind: 'empty' } : { kind: 'loaded', html: cachedHtml })
          return
        }
        const result = await window.ipc.invoke('workspace:readFile', { path })
        if (cancelled) return
        setCached(path, result.data, stat.mtimeMs, stat.size)
        if (!result.data || result.data.trim() === '') {
          setState({ kind: 'empty' })
          return
        }
        setState({ kind: 'loaded', html: result.data })
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setState({ kind: 'error', message })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [path])

  if (state.kind === 'error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <AlertCircleIcon className="size-6 text-destructive" />
        <p className="text-sm font-medium text-foreground">Could not load preview</p>
        <p className="max-w-md text-xs">{state.message}</p>
        <p className="text-xs opacity-60">{path}</p>
      </div>
    )
  }

  if (state.kind === 'empty') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileTextIcon className="size-6" />
        <p className="text-sm">This file is empty</p>
      </div>
    )
  }

  if (state.kind === 'tooLarge') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <FileTextIcon className="size-6" />
        <p className="text-sm font-medium text-foreground">File too large to preview</p>
        <p className="text-xs">
          {state.sizeMB.toFixed(1)} MB — preview limit is {(MAX_SIZE_BYTES / (1024 * 1024)).toFixed(0)} MB.
        </p>
        <button
          type="button"
          onClick={() => {
            void window.ipc.invoke('shell:openPath', { path })
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
        >
          <ExternalLinkIcon className="size-3.5" />
          Open in system
        </button>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      {state.kind === 'loaded' && (
        <iframe
          key={path}
          srcDoc={state.html}
          sandbox="allow-scripts"
          className="h-full w-full border-0 bg-white"
          title="HTML preview"
          onLoad={() => setIframeLoaded(true)}
        />
      )}
      {(state.kind === 'loading' || !iframeLoaded) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" />
          <p className="text-sm">Rendering preview…</p>
        </div>
      )}
    </div>
  )
}
