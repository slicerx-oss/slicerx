'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { tipAttrs } from './tooltip'

export interface ResizeEdgeProps {
  /** Where the pane sits. The edge is on its inner side: right of a left pane, left of a right pane, above a bottom pane. */
  pane: 'left' | 'right' | 'bottom'
  /** The pane's size in px along the drag axis (width, or height for a bottom pane). */
  size: number
  min: number
  max: number
  collapsed: boolean
  /** The size a collapsed pane shows (its rail). Dragging past it by a little opens the pane. */
  collapsedSize?: number
  onResize: (size: number) => void
  /** Called on release past the minimum, on a double-click of an open pane, and on Enter. */
  onCollapse: () => void
  /** Called while dragging a collapsed pane open (with the size), on a double-click and on Enter of a collapsed pane. */
  onExpand: (size?: number) => void
  /** Accessible name, such as "Resize the settings sidebar". */
  label: string
  /** The pane element, to measure the drag from its fixed edge. */
  measure: () => DOMRect | null
  /** True while the pointer is down on the edge, so the parent can switch off width animation. */
  onDraggingChange?: (dragging: boolean) => void
}

const KEY_STEP = 16
/** How far past the minimum a drag goes before it means collapse. */
const COLLAPSE_PAST = 48

/**
 * The draggable edge of a pane. Hovering or focusing it draws a thin green line with a soft glow; dragging resizes
 * between min and max, dragging past the minimum (or a double-click) collapses the pane to its rail, and dragging
 * the rail's edge opens it again. Arrow keys resize, Home and End jump to the limits, Enter toggles collapse.
 */
export function ResizeEdge({ pane, size, min, max, collapsed, collapsedSize = 52, onResize, onCollapse, onExpand, label, measure, onDraggingChange }: ResizeEdgeProps) {
  const [dragging, setDragging] = useState(false)
  const armed = useRef(false)
  const axisX = pane !== 'bottom'

  const rawSize = (e: PointerEvent): number | null => {
    const r = measure()
    if (!r) return null
    return pane === 'left' ? e.clientX - r.left : pane === 'right' ? r.right - e.clientX : r.bottom - e.clientY
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    armed.current = false
    setDragging(true)
    onDraggingChange?.(true)
    e.preventDefault()
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const raw = rawSize(e)
    if (raw === null) return
    if (collapsed) {
      if (raw > collapsedSize + COLLAPSE_PAST) onExpand(Math.max(min, Math.min(max, raw)))
      return
    }
    armed.current = raw < min - COLLAPSE_PAST
    onResize(Math.max(min, Math.min(max, raw)))
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    onDraggingChange?.(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (armed.current && !collapsed) onCollapse()
    armed.current = false
  }
  const grow = (sign: 1 | -1, big: boolean) => {
    if (collapsed) {
      if (sign === 1) onExpand()
      return
    }
    onResize(Math.max(min, Math.min(max, size + sign * (big ? KEY_STEP * 4 : KEY_STEP))))
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const growKey = pane === 'left' ? 'ArrowRight' : pane === 'right' ? 'ArrowLeft' : 'ArrowUp'
    const shrinkKey = pane === 'left' ? 'ArrowLeft' : pane === 'right' ? 'ArrowRight' : 'ArrowDown'
    if (e.key === growKey) grow(1, e.shiftKey)
    else if (e.key === shrinkKey) {
      if (!collapsed && size <= min) onCollapse()
      else grow(-1, e.shiftKey)
    } else if (e.key === 'Home') onResize(min)
    else if (e.key === 'End') onResize(max)
    else if (e.key === 'Enter' || e.key === ' ') (collapsed ? onExpand() : onCollapse())
    else return
    e.preventDefault()
  }
  return (
    <div
      className="sx-resize-edge"
      data-pane={pane}
      data-dragging={dragging ? true : undefined}
      role="separator"
      aria-orientation={axisX ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(collapsed ? 0 : size)}
      tabIndex={0}
      {...tipAttrs('pane.resize')}
      data-tip-side={pane === 'left' ? 'right' : pane === 'right' ? 'left' : 'top'}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => (collapsed ? onExpand() : onCollapse())}
      onKeyDown={onKey}
    >
      <i className="sx-resize-grip" aria-hidden="true" />
    </div>
  )
}
