import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import { ensureMarkdownExtension, normalizeWikiPath, wikiLabel } from '@/lib/wiki-links'

const wikiLinkInputRegex = /\[\[([^[\]]+)\]\]$/
const wikiLinkTokenRegex = /\[\[([^[\]]+)\]\]/g

type WikiLinkOptions = {
  onCreate?: (path: string) => void
}

const isInsideCode = (textNode: Text) =>
  Boolean(textNode.parentElement?.closest('code, pre, a, wiki-link'))

const replaceWikiLinksInTextNode = (textNode: Text) => {
  const text = textNode.nodeValue
  if (!text || !text.includes('[[')) return
  if (isInsideCode(textNode)) return

  const matches = [...text.matchAll(wikiLinkTokenRegex)]
  if (!matches.length) return

  const fragment = document.createDocumentFragment()
  let lastIndex = 0

  for (const match of matches) {
    const matchIndex = match.index ?? 0
    const matchText = match[0] ?? ''
    const rawPath = match[1]?.trim() ?? ''
    const normalizedPath = rawPath ? normalizeWikiPath(rawPath) : ''
    const isValidPath = normalizedPath && !normalizedPath.endsWith('/') && !normalizedPath.includes('..')

    if (matchIndex > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, matchIndex)))
    }

    if (isValidPath) {
      const el = document.createElement('wiki-link')
      el.setAttribute('data-path', ensureMarkdownExtension(normalizedPath))
      fragment.appendChild(el)
    } else {
      fragment.appendChild(document.createTextNode(matchText))
    }

    lastIndex = matchIndex + matchText.length
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
  }

  textNode.parentNode?.replaceChild(fragment, textNode)
}

const replaceWikiLinksInTextNodes = (root: HTMLElement) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text)
  }

  textNodes.forEach(replaceWikiLinksInTextNode)
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addOptions() {
    return {
      onCreate: undefined,
    }
  },

  addAttributes() {
    return {
      path: {
        default: '',
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'wiki-link[data-path]',
        getAttrs: (element: Element) => ({
          path: (element as HTMLElement).getAttribute('data-path') ?? '',
        }),
      },
      {
        tag: 'a[data-type="wiki-link"]',
        getAttrs: (element: Element) => ({
          path: (element as HTMLElement).getAttribute('data-path') ?? '',
        }),
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = wikiLabel(node.attrs.path) || node.attrs.path
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'wiki-link',
        'data-path': node.attrs.path,
        'href': '#',
        'class': 'wiki-link',
        'aria-label': node.attrs.path,
      }),
      label,
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (text: string) => void }, node: { attrs: { path?: string } }) {
          const path = node.attrs.path ?? ''
          state.write(`[[${path}]]`)
        },
        parse: {
          updateDOM(element: HTMLElement) {
            replaceWikiLinksInTextNodes(element)
          },
        },
      },
    }
  },

  addInputRules() {
    const onCreate = this.options.onCreate
    return [
      new InputRule({
        find: wikiLinkInputRegex,
        handler: ({ state, range, match }) => {
          const rawPath = match[1]?.trim()
          const normalizedPath = rawPath ? normalizeWikiPath(rawPath) : ''
          if (!normalizedPath || normalizedPath.endsWith('/') || normalizedPath.includes('..')) return null
          if (state.selection.$from.parent.type.spec.code) return null
          if (state.selection.$from.marks().some((mark) => mark.type.spec.code)) return null

          const finalPath = ensureMarkdownExtension(normalizedPath)
          state.tr.replaceWith(range.from, range.to, this.type.create({ path: finalPath }))
          onCreate?.(finalPath)
        },
      }),
    ]
  },
})
