import { useEffect, useState } from 'react'
import { HtmlFileViewer } from './html-file-viewer'
import { PdfFileViewer } from './pdf-file-viewer'

const CACHE_LIMIT = 5

function isCacheable(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.pdf')
}

function renderViewer(path: string): JSX.Element | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return <HtmlFileViewer path={path} />
  }
  if (lower.endsWith('.pdf')) {
    return <PdfFileViewer path={path} />
  }
  return null
}

interface PersistentViewerCacheProps {
  activePath: string
}

/**
 * Keeps recently-opened HTML and PDF viewers mounted in the DOM,
 * toggling visibility instead of unmounting. This preserves iframe
 * state (PDF page/zoom, HTML scroll/JS state) across file switches.
 */
export function PersistentViewerCache({ activePath }: PersistentViewerCacheProps) {
  const [mountedPaths, setMountedPaths] = useState<string[]>(() =>
    isCacheable(activePath) ? [activePath] : []
  )

  useEffect(() => {
    if (!isCacheable(activePath)) return
    setMountedPaths((prev) => {
      if (prev.includes(activePath)) {
        // Move to most-recent position
        return [...prev.filter((p) => p !== activePath), activePath]
      }
      const next = [...prev, activePath]
      return next.length > CACHE_LIMIT ? next.slice(-CACHE_LIMIT) : next
    })
  }, [activePath])

  return (
    <div className="relative h-full w-full">
      {mountedPaths.map((p) => (
        <div
          key={p}
          className="absolute inset-0"
          style={{ display: p === activePath ? 'block' : 'none' }}
        >
          {renderViewer(p)}
        </div>
      ))}
    </div>
  )
}
