// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A workspace sidebar: the @slicerx/ui Rail with its state kept per workspace
// in the app store. Wide windows start expanded,
// narrower ones as an icon rail; phones stack the pane under the main area.
import type { Workspace } from '@slicerx/contracts'
import { Rail, ResizeEdge, type IconName, type RailItem } from '@slicerx/ui'
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useLookChoice } from '../first-run/look'
import { useMediaQuery } from '../lib/media'
import { railOpen, set, setRail, useApp, type Side } from '../state/store'

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

export function SidePane({ side, ws, label, sections, children, footer, headExtra, width }: { side: Side; ws: Workspace; label: string; sections: readonly PaneSection[]; children: ReactNode; footer?: ReactNode; headExtra?: ReactNode; width?: number }) {
  const wide = useMediaQuery('(min-width: 1280px)')
  const phone = useMediaQuery('(max-width: 900px)')
  const open = useApp((s) => railOpen(s.rails, ws, side, wide))
  const dragging = useApp((s) => s.dragging)
  const bodyRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLElement>(null)
  const [size, setSize] = usePaneSize(`${ws}-${side}`, width ?? 288)
  const [resizing, setResizing] = useState(false)

  const onSelect = (item: RailItem) => {
    if (!open) setRail(ws, side, true)
    requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector(`[data-section="${item.id}"]`)
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }

  return (
    <Rail
      side={side}
      label={label}
      collapsed={phone ? false : !open}
      onCollapsedChange={(collapsed) => setRail(ws, side, !collapsed)}
      items={phone || open ? [] : sections.map((s) => ({ id: s.id, label: s.label, icon: s.icon }))}
      onSelect={onSelect}
      dropActive={dragging && side === 'right' && ws === 'prepare'}
      className={resizing ? 'pane resizing' : 'pane'}
      railRef={railRef}
      style={{ '--w-side': `${side === 'right' ? size - 24 : size}px` } as CSSProperties}
      {...(phone
        ? {}
        : {
            edge: (
              <ResizeEdge
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
              />
            ),
          })}
      {...(footer ? { footer } : {})}
      {...(headExtra ? { headExtra } : {})}
    >
      <div className="pane-body" ref={bodyRef}>
        {children}
      </div>
    </Rail>
  )
}
