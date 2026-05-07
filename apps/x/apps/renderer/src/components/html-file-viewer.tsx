import { useEffect, useState } from 'react'
import { Loader2Icon } from 'lucide-react'

interface HtmlFileViewerProps {
  html: string
  path: string
}

export function HtmlFileViewer({ html, path }: HtmlFileViewerProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false)

  useEffect(() => {
    setIframeLoaded(false)
  }, [path, html])

  const showSpinner = !html || !iframeLoaded

  return (
    <div className="relative h-full w-full">
      {html && (
        <iframe
          key={path}
          srcDoc={html}
          sandbox="allow-scripts"
          className="h-full w-full border-0 bg-white"
          title="HTML preview"
          onLoad={() => setIframeLoaded(true)}
        />
      )}
      {showSpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" />
          <p className="text-sm">Rendering preview…</p>
        </div>
      )}
    </div>
  )
}
