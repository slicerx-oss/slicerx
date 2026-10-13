// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate toolbar and, under it, the Solid / Layer lines / Toolpaths switch, as one group the person can drag
// anywhere in the view by the grip at the bar's end. The grip shows on hover in a place kept for it, so the buttons never
// move. The group stays inside the view, also when the view gets smaller. Where it was put is not kept: a new
// session, or a new view, starts it at the top.
import type { LayoutSpec } from '@slicerx/contracts'
import { tipAttrs } from '@slicerx/ui'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { PlateToolbar } from './plate-toolbar'

/** How far inside the view's edges the group stays, px. */
const MARGIN = 8
/** One arrow key press on the grip moves the group this far, px; ten times with Shift. */
const STEP = 16

type Offset = { x: number; y: number }

/** The offset that keeps a box at `box` (moved by `delta` from where `off` put it) inside `area`, less the margin. */
export function clampOffset(off: Offset, delta: Offset, box: DOMRect | { left: number; top: number; right: number; bottom: number }, area: { left: number; top: number; right: number; bottom: number }): Offset {
  const fit = (d: number, lo: number, hi: number, min: number, max: number) => Math.min(Math.max(d, min - lo), max - hi)
  const dx = fit(delta.x, box.left, box.right, area.left + MARGIN, area.right - MARGIN)
  const dy = fit(delta.y, box.top, box.bottom, area.top + MARGIN, area.bottom - MARGIN)
  return { x: off.x + dx, y: off.y + dy }
}

/** The grip at the bar's end: two columns of dots, drag to move the group, or the arrow keys once it has focus. */
function Grip({ onDrag, onKey }: { onDrag: (e: PointerEvent<HTMLButtonElement>) => void; onKey: (e: KeyboardEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className="plate-tools-grip" data-testid="plate-tools-grip" aria-label="Drag the toolbar" {...tipAttrs({ title: 'Drag the toolbar', body: 'Drag it anywhere in the view, or use the arrow keys.' })} onPointerDown={onDrag} onKeyDown={onKey}>
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </button>
  )
}

export function PlateToolsGroup({ layout, look }: { layout: LayoutSpec; look: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [off, setOff] = useState<Offset>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const offRef = useRef(off)
  offRef.current = off

  const area = () => ref.current?.closest('.vp')?.getBoundingClientRect() ?? null
  /** Moves the group by `delta` from where it is, kept inside the view. */
  const moveBy = (delta: Offset) => {
    const el = ref.current
    const a = area()
    if (!el || !a) return
    const cur = offRef.current
    const next = clampOffset(cur, delta, el.getBoundingClientRect(), a)
    if (next.x === cur.x && next.y === cur.y) return
    // Applied at once, so the next pointer move measures the group where it now is.
    offRef.current = next
    el.style.translate = `${next.x}px ${next.y}px`
    setOff(next)
  }

  // A smaller view (a pane opening, the window shrinking) keeps the moved group inside it.
  useLayoutEffect(() => {
    const vp = ref.current?.closest('.vp')
    if (!vp || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (offRef.current.x !== 0 || offRef.current.y !== 0) moveBy({ x: 0, y: 0 })
    })
    ro.observe(vp)
    return () => ro.disconnect()
  }, [])

  const drag = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const grip = e.currentTarget
    grip.setPointerCapture(e.pointerId)
    let last = { x: e.clientX, y: e.clientY }
    setDragging(true)
    const move = (m: globalThis.PointerEvent) => {
      moveBy({ x: m.clientX - last.x, y: m.clientY - last.y })
      last = { x: m.clientX, y: m.clientY }
    }
    const end = () => {
      setDragging(false)
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', end)
      grip.removeEventListener('pointercancel', end)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  }

  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? STEP * 10 : STEP
    const d = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }[e.key]
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    moveBy(d)
  }

  // The offset is applied by `translate`, which adds to the group's own centering transform.
  useEffect(() => {
    const el = ref.current
    if (el) el.style.translate = off.x || off.y ? `${off.x}px ${off.y}px` : ''
  }, [off])

  const moved = off.x !== 0 || off.y !== 0
  return (
    <div ref={ref} className="plate-tools-group" data-testid="plate-tools-group" data-placement={layout.toolbar} data-moved={moved || undefined} data-dragging={dragging || undefined}>
      <PlateToolbar layout={layout} grip={<Grip onDrag={drag} onKey={key} />} />
      {look}
    </div>
  )
}
