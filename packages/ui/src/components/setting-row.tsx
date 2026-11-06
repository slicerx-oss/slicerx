// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react'

export interface SettingRowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** The row's element: an li inside a list of settings, a div elsewhere. */
  as?: 'li' | 'div'
  /** The label, usually a label element pointing at the control. */
  label: ReactNode
  /** The control: a number field, a select, a switch or a segmented choice. It ends at the row's right edge. */
  control: ReactNode
  /** What sits in the left rail: the changed dot, the pin. Never inside the label, so the label never moves. */
  mark?: ReactNode
  /** What sits in the right rail: the reset button of a changed row. */
  reset?: ReactNode
  /** No rails: for a list where no row has a mark or a reset (Settings > Controls). The columns are otherwise the same. */
  bare?: boolean
  /** The label above a control that is full width by nature (a template, a prose field), for the whole row. */
  stack?: boolean
  /** Lines under the row (a note, chips), from the label's edge to the row's right edge. */
  children?: ReactNode
}

/** How one row's label sits beside its control: the lines its text takes, and whether a word runs past its column. */
export interface LabelFit {
  lines: number
  overflow: boolean
}

/** The most lines a label may take beside its control before its group stacks (spec 2b: long labels wrap to two lines first). */
export const INLINE_LABEL_LINES = 2

/**
 * Whether a group of rows stacks on a phone: when any label, beside its control, needs more than two lines or has a
 * word that does not fit. Stacked and inline rows never alternate inside a group, so one cramped row stacks them all.
 */
export function groupStacks(rows: readonly LabelFit[]): boolean {
  return rows.some((r) => r.overflow || r.lines > INLINE_LABEL_LINES)
}

/** The lines a label's own text takes. A block line inside it (a hint in a <small>, a setting key) is not counted. */
export function labelFit(label: Element): LabelFit {
  const tops = new Set<number>()
  const walk = document.createTreeWalker(label, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent?.trim()) continue
    let block = false
    for (let p = n.parentElement; p && p !== label; p = p.parentElement) if (getComputedStyle(p).display === 'block') block = true
    if (block) continue
    range.selectNodeContents(n)
    for (const r of Array.from(range.getClientRects())) if (r.width > 0) tops.add(Math.round(r.top))
  }
  return { lines: tops.size, overflow: label.scrollWidth > label.clientWidth + 1 }
}

/** The group's attribute: "stack" or "inline", set on a phone only. */
export const SETROWS_ATTR = 'data-setrows'

type Group = { observer: ResizeObserver; rows: number; pending: boolean }
const groups = new WeakMap<Element, Group>()

/**
 * Lays one group out on a phone: measures every row inline (the desktop layout) and marks the group "stack" when one
 * is cramped. It runs before the first paint and again when the group's width changes, so nothing moves on screen.
 */
export function layOutGroup(group: Element): void {
  const was = group.getAttribute(SETROWS_ATTR)
  if (!document.documentElement.hasAttribute('data-phone')) {
    if (was !== null) group.removeAttribute(SETROWS_ATTR)
    return
  }
  const rows = Array.from(group.children).filter((c) => c.classList.contains('sx-setrow') && !c.hasAttribute('data-stack'))
  if (was !== null) group.removeAttribute(SETROWS_ATTR)
  const fits = rows.map((r) => {
    const label = r.children[r.hasAttribute('data-bare') ? 0 : 1]
    return label ? labelFit(label) : { lines: 1, overflow: false }
  })
  group.setAttribute(SETROWS_ATTR, groupStacks(fits) ? 'stack' : 'inline')
}

function schedule(group: Element): void {
  const g = groups.get(group)
  if (!g || g.pending) return
  g.pending = true
  // once every row of this commit has mounted, and before the browser paints
  queueMicrotask(() => {
    g.pending = false
    if (groups.get(group) === g) layOutGroup(group)
  })
}

function join(group: Element): () => void {
  let g = groups.get(group)
  if (!g) {
    let width = -1
    const observer = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width ?? 0
      if (w === width) return
      width = w
      layOutGroup(group)
    })
    g = { observer, rows: 0, pending: false }
    groups.set(group, g)
    observer.observe(group)
    // labels measured before the web font arrives would count other lines
    if (document.fonts && document.fonts.status !== 'loaded') void document.fonts.ready.then(() => schedule(group))
  }
  g.rows++
  schedule(group)
  const mine = g
  return () => {
    mine.rows--
    if (mine.rows > 0) return schedule(group)
    mine.observer.disconnect()
    if (groups.get(group) === mine) groups.delete(group)
  }
}

/**
 * One settings row: mark rail, label, control, reset rail (--w-mark, 1fr, auto, --w-reset) with one gap. Every control
 * ends at the same right edge and every label starts at the same x, changed or not, pinned or not. On a phone the rows
 * that share a parent are one group: each stays on one line, or all of them put the label above the control.
 */
export function SettingRow({ as = 'div', label, control, mark, reset, bare, stack, className, children, ...rest }: SettingRowProps) {
  const Tag = as
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const group = ref.current?.parentElement
    if (!group || typeof ResizeObserver === 'undefined') return
    return join(group)
  }, [])
  return (
    <Tag ref={ref as never} className={className ? `sx-setrow ${className}` : 'sx-setrow'} data-bare={bare ? true : undefined} data-stack={stack ? true : undefined} {...rest}>
      {bare ? null : <span className="sx-setrow-mark">{mark}</span>}
      {label}
      {control}
      {bare ? null : <span className="sx-setrow-reset">{reset}</span>}
      {children}
    </Tag>
  )
}
