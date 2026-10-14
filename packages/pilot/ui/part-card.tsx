// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createContext, useContext } from 'react'
import { Button, Icon } from '@slicerx/ui'
import { partLine, partSize, partTitle, type CreatedPart, type FollowUp } from './part'

/** How the part card and its chips are laid out; one per look the owner picks from. */
export interface PartLook {
  icon: 'left' | 'top'
  actions: 'edit' | 'edit-select'
  lines: 1 | 2
  /** Chips under the reply's question, or in the prompt's suggestion row in place of the starters. */
  chips: 'reply' | 'prompt'
}

export const DEFAULT_PART_LOOK: PartLook = { icon: 'left', actions: 'edit', lines: 2, chips: 'reply' }

export const PartLookContext = createContext<PartLook>(DEFAULT_PART_LOOK)

/** What the card and chips do: open the part to edit, select it on the plate, send a chip's request. */
export interface PartHandlers {
  onEdit?: ((id: string) => void) | undefined
  onSelect?: ((id: string) => void) | undefined
  onRun?: ((request: string) => void) | undefined
}

/** A small isometric drawing of the part's bounding shape, its three faces shaded. */
export function PartGlyph({ part, size }: { part: CreatedPart; size: number }) {
  const [x, y, z] = part.sizeMm.map((v) => Math.max(v, 0.001)) as [number, number, number]
  if (part.kind === 'cylinder') {
    // an upright cylinder fitted into the 24 unit square, its top a 2:1 ellipse
    const d = Math.min(x, y)
    const k = Math.min(20 / d, 20 / (d * 0.5 + z))
    const r = d * k * 0.5
    const h = z * k
    const top = (24 - (r + h)) / 2 + r * 0.5
    const bot = top + h
    return (
      <svg className="part-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path className="pg-side" d={`M${12 - r},${top} V${bot} A${r},${r * 0.5} 0 0 0 ${12 + r},${bot} V${top} Z`} />
        <ellipse className="pg-top" cx={12} cy={top} rx={r} ry={r * 0.5} />
      </svg>
    )
  }
  // a 2:1 isometric of the box, fitted into the 24 unit square
  const k = Math.min(20 / ((x + y) * 0.866), 20 / ((x + y) * 0.5 + z))
  const a = x * k
  const b = y * k
  const h = z * k
  const ox = (24 - (a + b) * 0.866) / 2 + b * 0.866
  const oy = (24 - ((a + b) * 0.5 + h)) / 2
  const pt = (u: number, v: number, up: number): string => `${(ox + (u - v) * 0.866).toFixed(2)},${(oy + (u + v) * 0.5 + h - up).toFixed(2)}`
  const top = [pt(0, 0, h), pt(a, 0, h), pt(a, b, h), pt(0, b, h)].join(' ')
  const left = [pt(0, b, h), pt(a, b, h), pt(a, b, 0), pt(0, b, 0)].join(' ')
  const right = [pt(a, 0, h), pt(a, b, h), pt(a, b, 0), pt(a, 0, 0)].join(' ')
  return (
    <svg className="part-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <polygon className="pg-left" points={left} />
      <polygon className="pg-right" points={right} />
      <polygon className="pg-top" points={top} />
    </svg>
  )
}

/** The part a reply made: what it is, its size, and Edit (and Select) to take it from there. */
export function PartCard({ part, handlers }: { part: CreatedPart; handlers: PartHandlers }) {
  const look = useContext(PartLookContext)
  const title = partTitle(part)
  return (
    <div className="part-card" role="group" aria-label={title} data-testid="mimir-part" data-part={part.id} data-icon={look.icon} data-lines={look.lines}>
      <PartGlyph part={part} size={look.icon === 'top' ? 56 : 40} />
      <div className="part-text">
        <span className="part-title">{title}</span>
        {look.lines === 2 ? <span className="part-sub">{partLine(part)}</span> : <span className="part-sub">{partSize(part)}</span>}
      </div>
      <div className="part-acts">
        {look.actions === 'edit-select' ? (
          <Button size="sm" variant="ghost" onClick={() => handlers.onSelect?.(part.id)}>
            Select
          </Button>
        ) : null}
        <Button size="sm" onClick={() => handlers.onEdit?.(part.id)}>
          Edit
        </Button>
      </div>
    </div>
  )
}

/** The next steps for the part, each one sending its request as if typed. */
export function FollowUpChips({ items, onRun, place }: { items: readonly FollowUp[]; onRun?: ((request: string) => void) | undefined; place: 'reply' | 'prompt' }) {
  return (
    <div className={place === 'reply' ? 'follow follow-reply' : 'chips'} role="group" aria-label="Next steps">
      {items.map((f) => (
        <button key={f.id} type="button" className="sugg follow-chip" data-testid="mimir-follow" data-request={f.request} disabled={!onRun} onClick={() => onRun?.(f.request)}>
          {f.adds ? <Icon name="plus" /> : null}
          {f.label}
        </button>
      ))}
    </div>
  )
}
