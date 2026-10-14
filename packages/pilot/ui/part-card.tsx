// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useId, useState } from 'react'
import { Button, Icon, VectorField } from '@slicerx/ui'
import { followUps, partLine, partTitle, sizeRequest, type CreatedPart, type FollowUp } from './part'

/** What the card and chips do. Each names the part it was made for, never the current selection. */
export interface PartHandlers {
  /** Opens the part for editing: its modeling step, or its own size and placement panel. Without it there is no Edit. */
  onEdit?: ((id: string) => void) | undefined
  /** Selects the part on the plate, which highlights it. */
  onSelect?: ((id: string) => void) | undefined
  /** Sends a chip's request for that part. */
  onRun?: ((request: string, id: string) => void) | undefined
  /** False once the part is gone from the project; the card and chips then say so instead of acting. */
  has?: ((id: string) => boolean) | undefined
}

/** "The 20 mm cube is no longer in the project, so this step has nothing to change." */
export function goneNote(p: CreatedPart): string {
  return `The ${p.name} is no longer in the project, so this step has nothing to change.`
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

/** The part a reply made: what it is and its size. The body selects it; Edit opens it for editing. */
export function PartCard({ part, handlers }: { part: CreatedPart; handlers: PartHandlers }) {
  const [gone, setGone] = useState(false)
  const title = partTitle(part)
  const act = (fn: ((id: string) => void) | undefined) => () => {
    if (handlers.has && !handlers.has(part.id)) return setGone(true)
    setGone(false)
    fn?.(part.id)
  }
  return (
    <div className="part-card" role="group" aria-label={title} data-testid="mimir-part" data-part={part.id}>
      <div className="part-row">
        <button type="button" className="part-main" aria-label={`Select the ${part.name}`} onClick={act(handlers.onSelect)}>
          <PartGlyph part={part} size={40} />
          <span className="part-text">
            <span className="part-title">{title}</span>
            <span className="part-sub">{partLine(part)}</span>
          </span>
        </button>
        {handlers.onEdit ? (
          <Button size="sm" onClick={act(handlers.onEdit)} aria-label={`Edit the ${part.name}`}>
            Edit
          </Button>
        ) : null}
      </div>
      {gone ? (
        <p className="part-gone" role="status">
          {goneNote(part)}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The next steps for the part a reply made, bound to that part: an immediate step sends its request, the size step
 * asks for the new size first. When the part is gone they say so instead of acting.
 */
export function FollowUpChips({ part, handlers }: { part: CreatedPart; handlers: PartHandlers }) {
  const [gone, setGone] = useState(false)
  const [asking, setAsking] = useState(false)
  const [size, setSize] = useState<[number, number, number]>(part.sizeMm)
  const id = useId()
  const live = (): boolean => {
    const ok = !handlers.has || handlers.has(part.id)
    setGone(!ok)
    if (!ok) setAsking(false)
    return ok
  }
  const pick = (f: FollowUp) => {
    if (!live()) return
    if (f.asks === 'size') {
      setSize(part.sizeMm)
      return setAsking((a) => !a)
    }
    if (f.request) handlers.onRun?.(f.request, part.id)
  }
  const changed = size.some((v, i) => Math.abs(v - part.sizeMm[i]!) > 1e-6)
  return (
    <div className="follow" data-part={part.id}>
      <div className="follow-reply" role="group" aria-label="Next steps">
        {followUps(part).map((f) => (
          <button
            key={f.id}
            type="button"
            className="sugg follow-chip"
            data-testid="mimir-follow"
            {...(f.request ? { 'data-request': f.request } : {})}
            {...(f.asks ? { 'aria-expanded': asking, 'aria-controls': `${id}-size` } : {})}
            disabled={!handlers.onRun}
            onClick={() => pick(f)}
          >
            {f.adds ? <Icon name="plus" /> : null}
            {f.label}
          </button>
        ))}
      </div>
      {asking ? (
        // not a form: Enter in a field sets that axis, and only Resize sends
        <div id={`${id}-size`} className="follow-size" role="group" aria-label="Change size">
          <VectorField id={`${id}-xyz`} label="Size" unit="mm" ariaLabel={`New size of the ${part.name}`} values={size} min={0.1} onCommit={(i, v) => setSize((s) => s.map((x, k) => (k === i ? v : x)) as [number, number, number])} />
          <span className="follow-size-acts">
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                if (!live()) return
                setAsking(false)
                // the same size changes nothing, so nothing is sent
                if (changed) handlers.onRun?.(sizeRequest(part, size), part.id)
              }}
            >
              Resize
            </Button>
          </span>
        </div>
      ) : null}
      {gone ? (
        <p className="part-gone" role="status">
          {goneNote(part)}
        </p>
      ) : null}
    </div>
  )
}
