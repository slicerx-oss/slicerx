// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The setup preview: the SlicerX window in miniature, drawn from the look's own data (the real
// tabs component, the keymap, the plate tools, the sidebar order), with the two or three
// differences that matter pinned on it. The plate inside is the try-the-mouse box.
import { Icon, Tabs, type IconName } from '@slicerx/ui'
import type { ControlsMap } from '@slicerx/viewport'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { formatShortcut } from '../lib/keys'
import type { LookPreview, PreviewNote } from './look-preview'
import { MouseTry } from './mouse-try'
import { appName } from '../edition'
import { useApp } from '../state/store'

/** The glyph on a plate note's chip. */
const GESTURE_ICON: Record<string, IconName> = { scroll: 'trackpad-scroll', 'space-pan': 'keyboard', 'object-drag': 'move', views: 'iso-view', 'one-layer': 'layers', orbit: 'gesture-orbit', 'double-click': 'mouse-left' }

/** The Simple mode's goal tiles, as the Print settings section opens. */
const GOALS: readonly { label: string; icon: IconName }[] = [
  { label: 'Draft', icon: 'preset-draft' },
  { label: 'Standard', icon: 'preset-standard' },
  { label: 'Fine', icon: 'preset-fine' },
  { label: 'Strong', icon: 'preset-strong' },
]

const MODE_LABEL: Record<string, string> = { simple: 'Simple', advanced: 'Advanced', expert: 'Expert', developer: 'Developer' }

interface Pin {
  n: number
  x: number
  y: number
  ring: { x: number; y: number; w: number; h: number } | null
}

/** Where each note's pin goes: on its tab, the search field, the toolbar, the Slice row, or its gesture chip on the plate. */
function placePins(win: HTMLElement, notes: readonly PreviewNote[]): Pin[] {
  const box = win.getBoundingClientRect()
  const rel = (el: Element | null) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }
  }
  return notes.map((note, i) => {
    const n = i + 1
    const selector = note.target === 'tab' ? `.frp-bar .sx-tab[data-frp-tab="${note.tab ?? ''}"]` : note.target === 'search' ? '.frp-search' : note.target === 'tools' ? '.frp-tools' : note.target === 'plate' ? `.frp-gest[data-note="${note.id}"]` : '.frp-slicekey'
    const ring = rel(win.querySelector(selector))
    if (!ring) return { n, x: 0, y: 0, ring: null }
    const pad = 3
    const r = { x: ring.x - pad, y: ring.y - pad, w: ring.w + pad * 2, h: ring.h + pad * 2 }
    return { n, x: r.x + r.w, y: r.y, ring: r }
  })
}

/** Marks each tab with its workspace id so a pin can find it; the Tabs component itself stays as the app draws it. */
function useTabIds(host: { current: HTMLElement | null }, ids: readonly string[]): void {
  useLayoutEffect(() => {
    host.current?.querySelectorAll('.sx-tab').forEach((el, i) => el.setAttribute('data-frp-tab', ids[i] ?? ''))
  })
}

export function LayoutPreview({ preview, map, label, paintKey, autoSlice, head, phone = false, children }: { preview: LookPreview; map: ControlsMap; label: string; paintKey: string; autoSlice: boolean; head: ReactNode; phone?: boolean; children?: ReactNode }) {
  const win = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [pins, setPins] = useState<Pin[]>([])
  useTabIds(bar, preview.tabs.map((t) => t.id))
  // The settings mode chip in the pane title shows the mode picked beside the preview.
  const stored = useApp((s) => s.settingsMode)
  const mode = preview.modes.includes(stored) ? stored : 'advanced'

  useLayoutEffect(() => {
    const el = win.current
    if (!el) return
    const place = () => setPins(placePins(el, preview.notes))
    place()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [preview])

  const fmt = formatShortcut
  const tabs = preview.tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))
  return (
    <section className="frp" aria-labelledby="frp-h">
      <div className="frp-head">{head}</div>
      {phone ? null : (
      <div className="frp-stage">
        <div className="frp-win" ref={win} data-look={preview.id}>
          <p className="sr-only">
            The {appName()} window with this style. Tabs: {preview.tabs.map((t) => t.label).join(', ')}.
          </p>
          <div className="frp-bar" ref={bar} aria-hidden="true" inert>
            <span className="frp-brand">
              Slicer
              <Icon name="slicerx" size={11} />
            </span>
            <Tabs tabs={tabs} active={tabs[0]?.id ?? 'prepare'} label="Preview tabs" />
            <span className="frp-bar-right">
              <span className="frp-search">
                <Icon name="search" size={10} />
                Search
                {preview.palette ? <kbd>{fmt(preview.palette)}</kbd> : null}
              </span>
              <Icon name="settings" size={10} />
            </span>
          </div>
          <div className="frp-body">
            <div className="frp-side" aria-hidden="true" inert>
              <span className="frp-side-h">
                <span>Printer and settings</span>
                <i className="frp-mode-chip">
                  {MODE_LABEL[mode] ?? mode}
                  <Icon name="chevron-down" size={8} />
                </i>
              </span>
              {preview.sidebar.map((s) => (
                <div className="frp-sec" key={s} data-sec={s}>
                  <span className="frp-sec-h">{s}</span>
                  {s === 'Print settings' ? (
                    <>
                      <span className="frp-goal">
                        {GOALS.map((g, i) => (
                          <i key={g.label} data-on={i === 1 ? true : undefined}>
                            <Icon name={g.icon} size={10} />
                            {g.label}
                          </i>
                        ))}
                      </span>
                    </>
                  ) : (
                    <span className="frp-sk">
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              ))}
              <div className="frp-foot">
                <span className="frp-est">
                  Estimate
                  {preview.slice ? (
                    <span className="frp-slicekey">
                      Slice <kbd>{fmt(preview.slice)}</kbd>
                    </span>
                  ) : null}
                </span>
                <span className="frp-primary">{autoSlice ? 'Print' : 'Slice plate'}</span>
              </div>
            </div>
            <div className="frp-vp">
              <MouseTry map={map} label={label} paintKey={paintKey} />
              <div className="frp-tools" aria-hidden="true" inert>
                {preview.tools.map((t, i) => (
                  <span className="frp-tool" key={t.label} data-on={i === 0 ? true : undefined}>
                    <Icon name={t.icon} size={11} />
                    {t.key ? <kbd>{fmt(t.key)}</kbd> : null}
                  </span>
                ))}
                <i className="frp-sep" />
                <span className="frp-tool">
                  <Icon name="arrange" size={11} />
                </span>
                <i className="frp-sep" />
                <span className="frp-tool">
                  <Icon name="undo" size={11} />
                </span>
                <span className="frp-tool">
                  <Icon name="redo" size={11} />
                </span>
              </div>
              <div className="frp-gests" aria-hidden="true">
                {preview.notes
                  .filter((n) => n.target === 'plate')
                  .map((n) => (
                    <span className="frp-gest" key={`${preview.id}-${n.id}`} data-note={n.id}>
                      <Icon name={GESTURE_ICON[n.id] ?? 'mouse'} size={11} />
                      {n.short.charAt(0).toUpperCase() + n.short.slice(1)}
                    </span>
                  ))}
              </div>
              <span className="frp-corner" data-at="tl" aria-hidden="true">
                <Icon name="cube" size={10} />
              </span>
              <span className="frp-corner" data-at="tr" aria-hidden="true">
                <Icon name="settings" size={10} />
              </span>
            </div>
          </div>
          <div className="frp-pins" aria-hidden="true">
            {pins.map((p) => (
              <span key={`${preview.id}-${p.n}`}>
                {p.ring ? <i className="frp-ring" style={{ left: p.ring.x, top: p.ring.y, width: p.ring.w, height: p.ring.h }} /> : null}
                <b className="frp-pin" style={{ left: p.x, top: p.y }}>
                  {p.n}
                </b>
              </span>
            ))}
          </div>
        </div>
      </div>
      )}
      <ol className="frp-notes" aria-label="What changes with this style">
        {preview.notes.map((n, i) => (
          <li key={`${preview.id}-${n.id}`}>
            <b className="frp-num" aria-hidden="true">
              {i + 1}
            </b>
            <span className="frp-note">
              <span className="frp-note-t">{n.title}</span>
              <span className="frp-note-d">{n.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      {children}
    </section>
  )
}
