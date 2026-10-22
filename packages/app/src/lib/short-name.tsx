// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Names in buttons and chips stay on one line: a long one is cut in the middle, keeping its start and its end (a file
// name's extension), and the whole name is in the tooltip and the accessible name of the control around it.
import { useLayoutEffect, useRef, useState } from 'react'
import './short-name.css'

/** A printer's name as a button shows it: a project's own printer drops its " from <project>" (kept in the tooltip). */
export function shortPrinterName(name: string): string {
  return name.replace(/\s+from\s+.+$/i, '') || name
}

/** The name in two pieces for a cut in the middle: the end keeps the last `keep` characters with any extension. */
export function splitForMiddle(name: string, keep = 10): [string, string] {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : ''
  const base = ext ? name.slice(0, dot) : name
  const tail = Math.min(base.length, Math.max(0, keep - ext.length))
  return [base.slice(0, base.length - tail), base.slice(base.length - tail) + ext]
}

/** How many characters of `head` fit, with an ellipsis after them, in `room` px of the font `css` describes. */
function fitHead(head: string, css: CSSStyleDeclaration, room: number): number | null {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  ctx.font = css.font
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = css.letterSpacing
  let lo = 0
  let hi = head.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(`${head.slice(0, mid).trimEnd()}\u2026`).width <= room - 0.5) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * One line, cut in the middle when it does not fit; its text reads as the whole name. With `exact` the cut is measured:
 * the start ends in an ellipsis that sits flush against the end, with no space left after it (CSS alone leaves up to a
 * letter of room there). The control around it (its button) sets the room, and the cut is measured again when that
 * changes, so the control's width must not depend on its content (a full width button). A cut part carries data-cut.
 */
export function MiddleName({ name, className, exact }: { name: string; className?: string; exact?: boolean }) {
  const [head, tail] = splitForMiddle(name)
  const root = useRef<HTMLSpanElement>(null)
  // null: the whole start, cut by CSS while it is measured; a number: the start's characters kept before the ellipsis
  const [fit, setFit] = useState<{ name: string; kept: number } | null>(null)
  const kept = fit?.name === name ? fit.kept : null
  useLayoutEffect(() => {
    const el = root.current
    if (!exact || !el) return
    const box = el.closest('button') ?? el.parentElement
    if (!box) return
    const reset = () => setFit(null)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(reset)
    ro.observe(box)
    void document.fonts?.ready.then(reset)
    return () => ro.disconnect()
  }, [exact, name])
  useLayoutEffect(() => {
    const el = root.current
    const start = el?.firstElementChild as HTMLElement | null
    if (!exact || kept !== null || !start || start.scrollWidth <= start.clientWidth) return
    // the start's box is what the end leaves of the line
    const n = fitHead(head, getComputedStyle(start), start.clientWidth)
    if (n !== null && n < head.length) setFit({ name, kept: n })
  })
  const cut = exact && kept !== null
  return (
    <span ref={root} className={className ? `mid-name ${className}` : 'mid-name'} {...(cut ? { 'data-fit': true } : {})}>
      <span className="mid-head" {...(cut ? { 'data-cut': true } : {})}>{cut ? `${head.slice(0, kept).trimEnd()}\u2026` : head}</span>
      <span className="mid-tail">{tail}</span>
    </span>
  )
}
