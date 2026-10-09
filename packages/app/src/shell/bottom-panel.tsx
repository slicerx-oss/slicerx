// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A panel along the bottom of the view with a small ^ edge tab, that opens and closes by itself (auto-panel.ts). The tab
// is a real button: Tab reaches it, Enter or Space toggles it, as does Mod+J, focus moving into the panel opens it and
// Escape closes it and returns focus to the tab. Its context menu pins it open; the pin is remembered per panel with
// the pane sizes.
import { EdgeTab, keymapFor, Menu, MenuAnchor, MenuItem } from '@slicerx/ui'
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLookChoice } from '../first-run/look'
import { set, useApp } from '../state/store'
import { AutoPanel } from './auto-panel'
import { registerEdge } from './edge-keys'
import './bottom-panel.css'

/** How tall the band along the bottom of the view is that opens the panel. */
export const BAND_PX = 56

const PanelContext = createContext<{ drag(active: boolean): void; menu(open: boolean): void }>({ drag() {}, menu() {} })

/** For content inside the panel: hold it open while a drag or a menu is under way. */
export function useBottomPanel(): { drag(active: boolean): void; menu(open: boolean): void } {
  return useContext(PanelContext)
}

export function BottomPanel({ label, memory, panel, attention = 0, children }: { label: string; memory: string; panel: string; attention?: number; children: ReactNode }) {
  const id = useId()
  const pinKey = `${memory}:pinned`
  const pinned = useApp((s) => s.paneSizes[pinKey] === 1)
  const [open, setOpen] = useState(pinned)
  const [menu, setMenu] = useState(false)
  const ctl = useRef<AutoPanel | null>(null)
  ctl.current ??= new AutoPanel(setOpen, { pinned })
  const root = useRef<HTMLDivElement>(null)
  const choice = useLookChoice()
  const chord = keymapFor(choice.id, choice.overrides?.keys ?? {})['panel.bottom']
  const focusTab = () => root.current?.querySelector<HTMLButtonElement>('.sx-edge-tab')?.focus()

  useEffect(() => () => ctl.current?.dispose(), [])
  useEffect(() => registerEdge('bottom', () => ctl.current?.toggle()), [])
  useEffect(() => ctl.current?.pin(pinned), [pinned])
  const seen = useRef(attention)
  useEffect(() => {
    if (attention !== seen.current) ctl.current?.attention()
    seen.current = attention
  }, [attention])

  // The band: the bottom of the view the panel sits in. Touch and pen have no hover, so only a mouse opens it there.
  // Watched on the window in the capture phase: the 3D view handles its own pointer events and does not pass them on.
  useEffect(() => {
    const view = root.current?.parentElement
    if (!view) return
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const r = view.getBoundingClientRect()
      ctl.current?.band(e.clientY >= r.bottom - BAND_PX && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right)
    }
    window.addEventListener('pointermove', move, true)
    return () => window.removeEventListener('pointermove', move, true)
  }, [])

  // While open, the view's bottom-left pills (the model size) move up above the panel: its height is on the view as
  // --bpanel-h. bottom-panel.css reads it.
  useLayoutEffect(() => {
    const view = root.current?.parentElement
    const body = root.current?.querySelector<HTMLElement>('.bpanel-body')
    if (!view || !body || !open) return
    const put = () => view.style.setProperty('--bpanel-h', `${Math.round(body.getBoundingClientRect().height + 10)}px`)
    put()
    view.setAttribute('data-bpanel-open', '')
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(put)
    ro?.observe(body)
    return () => {
      ro?.disconnect()
      view.removeAttribute('data-bpanel-open')
      view.style.removeProperty('--bpanel-h')
    }
  }, [open])

  const setPinned = (on: boolean) => set((s) => ({ paneSizes: { ...s.paneSizes, [pinKey]: on ? 1 : 0 } }))
  const hold = { drag: (a: boolean) => ctl.current?.drag(a), menu: (o: boolean) => ctl.current?.menuOpen(o) }

  return (
    <div ref={root} className="bpanel" data-open={open || undefined} data-pinned={pinned || undefined}>
      <MenuAnchor>
        <EdgeTab
          side="bottom"
          open={open}
          label={label}
          panel={panel}
          controls={id}
          {...(chord ? { shortcut: chord } : {})}
          tip={pinned ? 'Kept open. Right-click to let it open and close by itself.' : 'Opens when the pointer reaches the bottom of the view. Right-click to keep it open.'}
          onToggle={() => ctl.current?.toggle()}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu(true)
            ctl.current?.menuOpen(true)
          }}
        />
        <Menu
          open={menu}
          onClose={() => {
            setMenu(false)
            ctl.current?.menuOpen(false)
          }}
          label={label}
        >
          <MenuItem icon={pinned ? 'check' : 'lock'} onClick={() => (setPinned(!pinned), setMenu(false), ctl.current?.menuOpen(false))}>
            {pinned ? 'Open and close by itself' : 'Keep it open'}
          </MenuItem>
        </Menu>
      </MenuAnchor>
      <section
        id={id}
        className="bpanel-body sx-overlay"
        aria-label={label}
        hidden={!open}
        onPointerEnter={() => ctl.current?.panel(true)}
        onPointerLeave={() => ctl.current?.panel(false)}
        onFocus={() => ctl.current?.focus(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) ctl.current?.focus(false)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || pinned) return
          e.stopPropagation()
          ctl.current?.close()
          focusTab()
        }}
      >
        <PanelContext.Provider value={hold}>{children}</PanelContext.Provider>
      </section>
    </div>
  )
}
