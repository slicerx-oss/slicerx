// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useId, useState } from 'react'
import type { Citation } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'

// Titles and URLs come from the model and web search, so only plain web links become anchors.
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

/** The reply's sources under it, folded to one "Sources (n)" line so the answer stays in view; it opens to the numbered list. */
export function Citations({ items }: { items: Citation[] }) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <div className={open ? 'cites open' : 'cites'}>
      <button type="button" className="cites-h" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <span>Sources ({items.length})</span>
        <Icon name="chevron-down" />
      </button>
      <ol className="cites-l" id={listId}>
        {items.map((c, i) => {
          const href = safeUrl(c.url)
          return (
            <li key={c.id}>
              <span className="cn">{i + 1}</span>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {c.title}
                </a>
              ) : (
                <span className="ct">{c.title}</span>
              )}
              {c.publisher ? <span className="cp">{c.publisher}</span> : null}
              {c.kind === 'web' ? <span className="cw">web</span> : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
