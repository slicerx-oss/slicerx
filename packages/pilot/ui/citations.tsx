// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { Citation } from '@slicerx/contracts'

// Titles and URLs come from the model and web search, so only plain web links become anchors.
function safeUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

/** A compact numbered source list under the reply. */
export function Citations({ items }: { items: Citation[] }) {
  if (items.length === 0) return null
  return (
    <div className="cites">
      <div className="cites-h">Sources</div>
      <ol className="cites-l">
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
