// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Lookup cards: what mimir looked up rises from the view's bottom edge as a lifted card with its source, left aligned
// with the caption. Two show at most; older ones fold into a chip that finds them in the conversation. A card closes
// with its button or Escape, and closing one never moves the other sideways (each keeps its slot). While a card shows,
// the camera frames the part above the band (viewport-host reads the band as a bottom inset).
import type { PilotLookup } from '@slicerx/contracts'
import { safeUrl } from '@slicerx/pilot/ui'
import { Button, Icon } from '@slicerx/ui'
import { useRef } from 'react'
import { closeLookup, lookupStore, MAX_CARDS, shownLookups, useLookups } from './lookups'
import './mimir.css'

/** Finds a lookup's record in the conversation and brings it into view. */
function showRecord(id: string): void {
  const el = document.querySelector<HTMLElement>(`[data-testid="mimir-transcript"] [data-lookup-id="${CSS.escape(id)}"]`)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/**
 * Gives each shown card a slot (0 is the left) and keeps it while the card stays on screen, so closing one card never
 * moves the other. A new card takes the free slot.
 */
export function assignSlots(cards: readonly PilotLookup[], prev: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of cards) {
    const had = prev.get(c.id)
    if (had !== undefined) out.set(c.id, had)
  }
  for (const c of cards) {
    if (out.has(c.id)) continue
    const used = new Set(out.values())
    let slot = 0
    while (used.has(slot)) slot++
    out.set(c.id, slot)
  }
  return out
}

export function LookupCards() {
  const all = useLookups((s) => s.all)
  const closed = useLookups((s) => s.closed)
  const { cards, folded } = shownLookups({ all, closed })
  const slots = useRef<Map<string, number>>(new Map())
  slots.current = assignSlots(cards, slots.current)
  if (cards.length === 0) return null
  const open = all.filter((l) => !closed.includes(l.id))
  return (
    <div className="mimir-lookups" data-cards={cards.length} role="region" aria-label="Looked up">
      {cards.map((l) => (
        <article
          style={{ gridColumn: (slots.current.get(l.id) ?? 0) + 1 }}
          key={l.id}
          className="mimir-lookup sx-overlay"
          data-testid="mimir-lookup-card"
          data-lookup-id={l.id}
          tabIndex={-1}
          aria-label={l.title}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            closeLookup(l.id)
          }}
        >
          <header className="mimir-lookup-h">
            <Icon name="search" size={14} />
            <span className="mimir-lookup-t">{l.title}</span>
            <Button size="sm" variant="ghost" icon="close" aria-label={`Close ${l.title}`} data-testid="mimir-lookup-close" onClick={() => closeLookup(l.id)} />
          </header>
          <dl className="mimir-lookup-f">
            {/* Two rows fit the card; the whole record is in the conversation. */}
            {l.fields.slice(0, 2).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {safeUrl(l.source.url) ? (
            <a className="mimir-lookup-s" href={safeUrl(l.source.url)!} target="_blank" rel="noreferrer noopener">
              {l.source.title}
            </a>
          ) : (
            <span className="mimir-lookup-s">{l.source.title}</span>
          )}
        </article>
      ))}
      {folded > 0 ? (
        <button type="button" className="mimir-lookup-more sx-overlay" style={{ gridColumn: MAX_CARDS + 1 }} onClick={() => showRecord(open[0]!.id)}>
          {folded} more
        </button>
      ) : null}
    </div>
  )
}

export { lookupStore, MAX_CARDS }
