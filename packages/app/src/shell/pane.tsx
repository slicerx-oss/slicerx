// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A workspace sidebar: the @slicerx/ui Rail with its state kept per workspace
// in the app store. Wide windows start expanded,
// narrower ones as an icon rail; phones stack the pane under the main area, except a pane with an edge tab, which is a
// bottom sheet over the view there: its tab on the screen edge opens it, one sheet at a time, and Escape, a tap
// outside or a drag down on its handle closes it.
// A pane with an edge tab (Model and Slice) shuts and opens from the tab on its inner edge and from [ or ] instead of
// the rail's own toggle, and with no hover peek, since the pointer rests on the tab right after it shuts the pane. Model's
// panes shut all the way, so the view takes the whole width; Slice's keep the icon rail.
import type { Workspace } from '@slicerx/contracts'
import { EdgeTab, keymapFor, Rail, ResizeEdge, type IconName, type RailItem } from '@slicerx/ui'
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createStore, useStore } from 'zustand'
import { useLookChoice } from '../first-run/look'
import { useMediaQuery } from '../lib/media'
import { get, railOpen, set, setRail, useApp, type Side } from '../state/store'
import { registerEdge } from './edge-keys'
import './pane.css'

export interface PaneSection {
  id: string
  icon: IconName
  label: string
}

/** Size limits of a side pane in px. The right pane draws 24 px wider than its variable, which the sizes already include. */
export const PANE_LIMITS = { min: 240, max: 560 } as const

/** A pane's saved size for the active look, or its default. Sizes are remembered per look preset. */
export function usePaneSize(pane: string, fallback: number, limits: { min: number; max: number } = PANE_LIMITS): [number, (px: number) => void] {
  const look = useLookChoice().id
  const key = `${look}:${pane}`
  const saved = useApp((s) => s.paneSizes[key])
  const size = Math.max(limits.min, Math.min(limits.max, saved ?? fallback))
  return [size, (px) => set((st) => ({ paneSizes: { ...st.paneSizes, [key]: Math.round(px) } }))]
}

/** A pane's edge tab: which panel it is (data-panel, and the pane body's test id) and whether the pane shuts all the way. */
export interface PaneTab {
  panel: string
  shutFully?: boolean
}

/** The open phone sheet, by `${ws}:${side}`. One at a time, and not remembered: a phone opens on the view. */
export const sheets = createStore<{ open: string | null }>()(() => ({ open: null }))

/** Opens or closes a phone sheet. */
export function setSheet(key: string, open: boolean): void {
  sheets.setState((s) => ({ open: open ? key : s.open === key ? null : s.open }))
}

/** A sheet's handle: a drag down of more than 80 px closes it, a shorter one springs back. */
function SheetHandle({ sheet, onClose }: { sheet: () => HTMLElement | null; onClose: () => void }) {
  const start = useRef<number | null>(null)
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return
    const dy = Math.max(0, e.clientY - start.current)
    sheet()?.style.setProperty('transform', `translateY(${dy}px)`)
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return
    const dy = e.clientY - start.current
    start.current = null
    sheet()?.style.removeProperty('transform')
    if (dy > 80) onClose()
  }
  return (
    <div
      className="sheet-handle"
      aria-hidden="true"
      onPointerDown={(e) => {
        start.current = e.clientY
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  )
}

/** The chord the active look binds to an action, for a tip. */
function useChord(action: 'panel.left' | 'panel.right'): string | undefined {
  const choice = useLookChoice()
  return keymapFor(choice.id, choice.overrides?.keys ?? {})[action] ?? undefined
}

export function SidePane({ side, ws, label, sections, children, footer, pinned, headExtra, width, tab }: { side: Side; ws: Workspace; label: string; sections: readonly PaneSection[]; children: ReactNode; footer?: ReactNode; pinned?: ReactNode; headExtra?: ReactNode; width?: number; tab?: PaneTab }) {
  const wide = useMediaQuery('(min-width: 1280px)')
  const phone = useMediaQuery('(max-width: 900px)')
  const open = useApp((s) => railOpen(s.rails, ws, side, wide))
  const bodyId = useId()
  const chord = useChord(side === 'left' ? 'panel.left' : 'panel.right')
  const edgeTab = tab !== undefined && !phone
  const full = edgeTab && tab.shutFully === true
  const sheet = tab !== undefined && phone
  const sheetKey = `${ws}:${side}`
  const sheetOpen = useStore(sheets, (s) => s.open === sheetKey)
  const dragging = useApp((s) => s.dragging)
  const bodyRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLElement>(null)
  const [size, setSize] = usePaneSize(`${ws}-${side}`, width ?? 288)
  const [resizing, setResizing] = useState(false)

  useEffect(() => (edgeTab ? registerEdge(side, () => setRail(ws, side, !railOpen(get().rails, ws, side, wide))) : undefined), [edgeTab, side, ws, wide])
  useEffect(() => (sheet ? registerEdge(side, () => setSheet(sheetKey, sheets.getState().open !== sheetKey)) : undefined), [sheet, side, sheetKey])
  // A shut sheet sits below the screen: out of the tab order and away from readers. Escape closes an open one.
  useEffect(() => {
    const el = railRef.current
    if (!el) return
    el.inert = sheet && !sheetOpen
    if (!sheet || !sheetOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      setSheet(sheetKey, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet, sheetOpen, sheetKey])
  // A sheet closes when its pane goes (switching between Model and Slice).
  useEffect(() => () => setSheet(sheetKey, false), [sheetKey])

  const onSelect = (item: RailItem) => {
    if (!open) setRail(ws, side, true)
    requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector(`[data-section="${item.id}"]`)
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }

  const rail = (
    <Rail
      side={side}
      label={label}
      collapsed={phone ? false : !open}
      onCollapsedChange={(collapsed) => setRail(ws, side, !collapsed)}
      items={phone || open || full ? [] : sections.map((s) => ({ id: s.id, label: s.label, icon: s.icon }))}
      onSelect={onSelect}
      dropActive={dragging && side === 'right' && ws === 'prepare'}
      className={['pane', resizing ? 'resizing' : '', edgeTab ? 'edged' : '', full ? 'shuts' : '', sheet ? 'sheet' : '', sheet && sheetOpen ? 'sheet-open' : ''].filter(Boolean).join(' ')}
      railRef={railRef}
      style={{ '--w-side': `${side === 'right' ? size - 24 : size}px` } as CSSProperties}
      {...(tab ? { toggle: false, peekOnHover: false } : {})}
      {...(phone
        ? sheet
          ? { edge: <SheetHandle sheet={() => railRef.current} onClose={() => setSheet(sheetKey, false)} /> }
          : {}
        : {
            edge: (
              <>
              {edgeTab ? <EdgeTab side={side} open={open} onToggle={() => setRail(ws, side, !open)} label={label} panel={tab.panel} controls={bodyId} {...(chord ? { shortcut: chord } : {})} /> : null}
              {full && !open ? null : <ResizeEdge
                pane={side}
                size={size}
                min={PANE_LIMITS.min}
                max={PANE_LIMITS.max}
                collapsed={!open}
                collapsedSize={52}
                label={`Resize ${label.toLowerCase()}`}
                measure={() => railRef.current?.getBoundingClientRect() ?? null}
                onDraggingChange={setResizing}
                onResize={setSize}
                onCollapse={() => setRail(ws, side, false)}
                onExpand={(px) => {
                  if (px !== undefined) setSize(px)
                  setRail(ws, side, true)
                }}
              />}
              </>
            ),
          })}
      {...(footer ? { footer } : {})}
      {...(pinned ? { pinned: <div className="pane-body pane-pin">{pinned}</div> } : {})}
      {...(headExtra ? { headExtra } : {})}
    >
      <div className="pane-body" ref={bodyRef} id={bodyId} {...(tab ? { 'data-testid': tab.panel } : {})}>
        {children}
      </div>
    </Rail>
  )
  if (!sheet) return rail
  // The tab and the scrim go in the body, so they sit on the screen whatever the page scroll; the sheet stays in the
  // studio, where its panels get their styles.
  return (
    <>
      {rail}
      {createPortal(
        <>
          {sheetOpen ? <div className="sheet-scrim" aria-hidden="true" onClick={() => setSheet(sheetKey, false)} /> : null}
          <EdgeTab side={side} open={sheetOpen} onToggle={() => setSheet(sheetKey, !sheetOpen)} label={label} panel={tab.panel} controls={bodyId} className="sheet-tab" />
        </>,
        document.body,
      )}
    </>
  )
}
