// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension sheet in the mimir tab, laid out as a drawing: while a sheet waits, the view becomes a drawing sheet
// (front, right, top and iso, with a numbered callout for each size) and the sheet's record in the chat is where the
// sizes are typed, row numbers matching the callouts. Nothing builds until the record's build button. After the build
// a panel docked on the right comes back from the record, and editing a tied row there edits the step it set. Picking
// a callout picks its row and the other way round. A phone shows Top and Isometric, or Front or Right on their own,
// picked by name when they draw a callout, and can fold the drawing to its header (drawing-pick.ts). On a phone the
// panel takes the chat's place instead, between its header and the composer.
import { drawingPick, foldDrawing, PANE_NAMES, PANE_VIEWS, paneOffered, panesFor, paneShowing, pickFor, showPane, usePhoneDrawing, type PhonePane } from './drawing-pick'
import { assistantText } from '@slicerx/contracts'
import { dimText, dimUnit as unitOf, wholeCount } from '@slicerx/contracts/size-kind'
import type { PilotDim, PilotSheet } from '@slicerx/contracts'
import { Button, Icon, Seg, tipAttrs, type IconName } from '@slicerx/ui'
import { ScrubNumber } from '@slicerx/ui/scrub'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePhoneLayout } from '../../lib/phone-layout'
import { usePhoneKeyboardUp } from '../../shell/phone-keyboard'
import { arrowHead, drawPx, drawView, fitScale, paintedEdges, SHEET_VIEWS, VIEWS, viewsFor, type Raster } from './sheet-draw'
import { sharedPicture, type SheetPicture } from './sheet-shape'
import { useApp } from '../../state/store'
import { closeSheet, setDraft, setLive, sheetMode, useSheetUi } from './sheet-ui'
import './mimir.css'

const SOURCE: Record<PilotDim['source'], { label: string; icon: IconName }> = {
  asked: { label: 'You said', icon: 'comment' },
  lookup: { label: 'Looked up', icon: 'globe' },
  photo: { label: 'Photo', icon: 'camera' },
  guess: { label: 'Guess', icon: 'help' },
}

/** How a row's value reads: its unit (unitOf: a count given in mm has none), the word a screen reader says, and the field's step. */
function dimUnit(d: Pick<PilotDim, 'key' | 'unit' | 'kind'>): { unit: string; word: string; step: number } {
  const unit = unitOf(d)
  if (unit === '') return { unit, word: '', step: 1 }
  if (unit === '°') return { unit, word: 'degrees', step: 1 }
  if (unit === '%') return { unit, word: 'percent', step: 0.5 }
  return { unit, word: 'millimeters', step: 0.5 }
}

/** The site a looked-up size came from, for its chip. */
export function sourceHost(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

/** The row's field id, for focusing it from a callout. */
const fieldId = (sheetId: string, key: string): string => `mimir-sheet-${sheetId}-${key}`
/** The same row's field on the sheet's record in the chat (sheet-record.tsx in the pilot UI). */
const recordId = (sheetId: string, key: string): string => `sheet-rec-${sheetId}-${key}`

function focusRow(sheetId: string, key: string): void {
  const el = document.getElementById(fieldId(sheetId, key)) ?? document.getElementById(recordId(sheetId, key))
  el?.focus()
  el?.scrollIntoView({ block: 'nearest' })
}

/**
 * The drawing's part and rows for a waiting sheet: the design as built when it names one on the plate, else its solids.
 * Made once per sheet and design entry and shared (sharedPicture), however many parts of the tab ask for it.
 */
export function useSheetPicture(sheet: PilotSheet | null): SheetPicture | null {
  // only the named design's entry, so other objects moving leave the drawing alone
  const entry = useApp((s) => (sheet?.design ? (s.plate.find((p) => p.id === sheet.design) ?? null) : null))
  return useMemo(() => (sheet ? sharedPicture(sheet, entry) : null), [sheet, entry])
}

/** The theme attributes the app sets on the root; nothing else there changes the drawing's inks. */
const THEME_ATTRS = ['data-scheme', 'data-theme', 'class']

/** A computed color as 0 to 255 channels, read by its function: rgb() and rgba() in 0 to 255, color() in 0 to 1. */
export function inkOf(css: string): [number, number, number] {
  const m = css.match(/^\s*(rgba?|color)\((.*)\)\s*$/i)
  if (!m) return [128, 128, 128]
  const nums = (m[2] ?? '').match(/-?[\d.]+/g)?.map(Number) ?? []
  const rgb = m[1]!.toLowerCase() === 'color' ? nums.slice(0, 3).map((v) => Math.round(v * 255)) : nums.slice(0, 3)
  return rgb.length === 3 ? (rgb as [number, number, number]) : [128, 128, 128]
}

/** The part's silhouette and edges in the drawing's own two inks, read from the stylesheet so they follow the theme. */
function PartCanvas({ raster, w, h }: { raster: Raster; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  // the inks as text, so a change on the root that leaves them alone repaints nothing
  const [inks, setInks] = useState('')
  useLayoutEffect(() => {
    const c = ref.current
    if (!c) return
    const read = () => {
      const ink = (cls: string): [number, number, number] => {
        const probe = document.createElement('span')
        probe.className = cls
        c.parentElement!.appendChild(probe)
        const v = inkOf(getComputedStyle(probe).color)
        probe.remove()
        return v
      }
      setInks(JSON.stringify([ink('mimir-ink-part'), ink('mimir-ink-edge')]))
    }
    read()
    // the inks change with the theme: the page's scheme, or the app's own light or dark on the root
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener?.('change', read)
    const mo = new MutationObserver(read)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRS })
    return () => {
      mq?.removeEventListener?.('change', read)
      mo.disconnect()
    }
  }, [])
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx || !inks) return
    const [fill, line] = JSON.parse(inks) as [number, number, number][]
    const img = ctx.createImageData(raster.W, raster.H)
    const px = img.data
    const edges = paintedEdges(raster)
    for (let i = 0; i < raster.cover.length; i++) {
      const c3 = edges[i] ? line! : raster.cover[i] ? fill! : null
      if (!c3) continue
      px[4 * i] = c3[0]
      px[4 * i + 1] = c3[1]
      px[4 * i + 2] = c3[2]
      px[4 * i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }, [raster, inks])
  return <canvas ref={ref} className="mimir-drawing-part" width={raster.W} height={raster.H} style={{ width: w, height: h }} aria-hidden="true" />
}

/** How long the drawing's cell must hold still before the views are drawn again at its new size, in ms. */
const SETTLE_MS = 120

/** Room around a view's drawing for its view label and callouts, in px. */
const PAD = 24
/** On a phone the view's label has a band of its own over the drawing, so no callout can cover it. */
const PHONE_LABEL_H = 22

/**
 * The drawing: four views in a 2 x 2 frame, the flat ones at one scale, its title, units and state on the frame's
 * bottom edge. On a phone Top and Isometric share the frame side by side, a picker in the header swaps them for Front
 * or Right (only those that draw a callout; with neither the header names the drawing instead), and a 44 px control
 * folds the drawing to its header (the view gives the chat the room).
 */
function SheetDrawing({ sheet, picture, editing, onPick }: { sheet: PilotSheet; picture: SheetPicture; editing: string | null; onPick: (key: string) => void }) {
  const dims = picture.dims
  // a guess stays marked until its row is typed in or kept with Enter
  const draft = useSheetUi((s) => s.draft)
  const assumed = (key: string): boolean => sheet.dims.some((d) => d.key === key && d.source === 'guess') && !(key in draft)
  const { phone, pane: picked, folded: foldedByHand } = usePhoneDrawing(sheet.id)
  // With the keyboard up for a size on the record, the drawing folds to its header so the record and its Confirm have
  // the room, and opens again when the keyboard goes. Its fold control gives way meanwhile, since a tap on it would take
  // the focus from the size and the keyboard with it.
  const keyboardUp = usePhoneKeyboardUp()
  const typing = phone && keyboardUp && editing !== null
  const folded = foldedByHand || typing
  // Front or Right with no callout of this sheet's would show nothing to edit, so the picker leaves it out
  const offered = useMemo(() => panesFor(viewsFor(dims, sheet.views ?? [])), [dims, sheet.views])
  const pane = paneOffered(picked, offered)
  const cols = phone ? PANE_VIEWS[pane].length : 2
  const ref = useRef<HTMLDivElement>(null)
  const [cell, setCell] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // a phone draws its views in one row of the whole frame, under their labels' band
    const [rows, band] = phone ? [1, PHONE_LABEL_H] : [2, 0]
    const size = () => {
      const r = el.getBoundingClientRect()
      return { w: Math.max(80, Math.floor(r.width / cols)), h: Math.max(60, Math.floor(r.height / rows) - band) }
    }
    setCell(size())
    // a drag of the pane's edge, a turned phone or the keyboard going up resizes it many times a second: the views are
    // drawn again once it holds still, not on every step
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const next = size()
        setCell((c) => (c && c.w === next.w && c.h === next.h ? c : next))
      }, SETTLE_MS)
    })
    ro.observe(el)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [phone, cols])
  const shape = picture.shape
  const views = useMemo(() => {
    if (!cell) return null
    const shownViews = phone ? PANE_VIEWS[pane] : SHEET_VIEWS
    // the flat views share one scale, as a print drawing does; the iso view fits its own cell
    const flat = Math.min(...SHEET_VIEWS.filter((v) => v !== 'iso').map((v) => fitScale(shape, dims, v, cell.w, cell.h, PAD, sheet.views)))
    // the screen's own pixel ratio up to 2, kept under a pixel budget per view so a big cell never makes a huge canvas
    const px = drawPx(cell.w, cell.h, typeof window === 'undefined' ? 1 : window.devicePixelRatio)
    return shownViews.map((v) => ({ v, drawn: drawView(shape, dims, v, cell.w, cell.h, { pad: PAD, px, order: sheet.views, ...(v === 'iso' ? {} : { scale: flat }) }) }))
  }, [cell, shape, dims, sheet.views, phone, pane])
  // a row picked on the record shows its callout: a phone moves to Top and iso when Front or Right does not draw it
  useEffect(() => {
    if (!phone || !editing) return
    const has = viewsFor(dims, sheet.views ?? []).get(editing)
    if (has) showPane(sheet.id, paneShowing(pickFor(drawingPick.getState(), sheet.id).pane, (v) => has.includes(v)))
  }, [phone, editing, sheet.id, dims, sheet.views])
  // the choice picked is no longer offered (the sheet changed): the pick moves back to Top and iso as well
  useEffect(() => {
    if (phone && pane !== picked) showPane(sheet.id, pane, offered)
  }, [phone, pane, picked, sheet.id, offered])
  // folded, the view gives the chat its room (mimir.css)
  useEffect(() => {
    const vp = document.querySelector<HTMLElement>('.studio > .vp')
    if (!vp) return
    if (folded) vp.dataset['mimirDrawing'] = 'folded'
    else delete vp.dataset['mimirDrawing']
    return () => {
      delete vp.dataset['mimirDrawing']
    }
  }, [folded])
  return (
    <div className="mimir-drawing" data-testid="mimir-sheet-drawing" data-phone={phone || undefined} data-folded={folded || undefined}>
      <div className="mimir-drawing-card">
      <div className="mimir-drawing-head">
        {!phone ? (
          <span className="mimir-drawing-title sx-mono">Drawing, four views</span>
        ) : folded || offered.length < 2 ? (
          <span className="mimir-drawing-name" data-testid="mimir-drawing-name">Drawing</span>
        ) : (
          <div className="mimir-drawing-views" data-testid="mimir-drawing-views">
            <Seg<PhonePane> label="Drawing view" value={pane} onChange={(p) => showPane(sheet.id, p, offered)} full options={offered.map((p) => ({ value: p, label: PANE_NAMES[p], testId: `mimir-drawing-view-${p}` }))} />
          </div>
        )}
        {phone && !typing ? (
          <Button
            variant="ghost"
            icon={folded ? 'chevron-down' : 'chevron-up'}
            className="mimir-drawing-fold"
            data-testid="mimir-drawing-fold"
            aria-label={folded ? 'Show drawing' : 'Hide drawing'}
            aria-expanded={!folded}
            onClick={() => foldDrawing(sheet.id)}
          />
        ) : null}
      </div>
      <div ref={ref} className="mimir-drawing-grid" hidden={folded}>
        {views?.map(({ v, drawn }) => (
          <div key={v} className="mimir-drawing-cell" data-view={v}>
            <PartCanvas raster={drawn.part} w={cell!.w} h={cell!.h} />
            <svg width={cell!.w} height={cell!.h} viewBox={`0 0 ${cell!.w} ${cell!.h}`} role="img" aria-label={`${sheet.title}, ${VIEWS[v].label}`}>
              {drawn.dims.map((d) => {
                // a halo in the card's color first, so the lines read over the part as well as beside it
                const strokes = (halo: boolean) => (
                  <g className={halo ? 'mimir-dim-halo' : undefined}>
                    {d.lines.map(([a, b], i) => (
                      <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
                    ))}
                    {d.arc ? <polyline points={d.arc.map((p) => p.join(',')).join(' ')} /> : null}
                    {d.leader ? <line className="mimir-dim-leader" x1={d.leader[0][0]} y1={d.leader[0][1]} x2={d.leader[1][0]} y2={d.leader[1][1]} /> : null}
                  </g>
                )
                return (
                  <g key={d.key} className="mimir-dim" data-key={d.key} data-on={editing === d.key || undefined} data-guess={assumed(d.key) || undefined}>
                    {strokes(true)}
                    {strokes(false)}
                    {d.leader && d.inside ? <circle className="mimir-dim-dot" cx={d.leader[0][0]} cy={d.leader[0][1]} r={2.4} /> : null}
                    {d.arrows.map(([tip, from], i) => (
                      <polygon key={i} className="mimir-dim-arrow" points={arrowHead(tip, from)} />
                    ))}
                  </g>
                )
              })}
              {drawn.dims.map((d) => {
                const dim = dims.find((x) => x.key === d.key)!
                return (
                  <g
                    key={d.key}
                    className="mimir-callout"
                    data-source={dim.source === 'guess' && !assumed(d.key) ? 'asked' : dim.source}
                    data-on={editing === d.key || undefined}
                    data-testid="mimir-sheet-callout"
                    data-key={d.key}
                    role="button"
                    tabIndex={-1}
                    aria-label={`${d.n}, ${dim.label}`}
                    onClick={() => onPick(d.key)}
                  >
                    {/* on a phone, an invisible circle 44 px across takes the touch around the 20 px badge */}
                    {phone ? <circle className="mimir-callout-hit" cx={d.badge[0]} cy={d.badge[1]} r={22} /> : null}
                    <circle cx={d.badge[0]} cy={d.badge[1]} r={10} />
                    <text x={d.badge[0]} y={d.badge[1] + 0.5}>
                      {d.n}
                    </text>
                  </g>
                )
              })}
            </svg>
            <span className="mimir-drawing-label sx-mono">{VIEWS[v].label}</span>
          </div>
        ))}
      </div>
      <div className="mimir-drawing-strip sx-mono" data-testid="mimir-drawing-status">
        <span>{sheet.title}</span>
        <span>mm</span>
        <span data-testid="mimir-drawing-built">{picture.built ? 'As built' : 'Not built yet'}</span>
      </div>
      </div>
    </div>
  )
}

function Chip({ dim, changed }: { dim: PilotDim; changed: boolean }) {
  if (changed) {
    return (
      <span className="mimir-chip" data-source="asked">
        <Icon name="comment" size={13} />
        Yours
      </span>
    )
  }
  const s = SOURCE[dim.source]
  const host = dim.source === 'lookup' ? sourceHost(dim.sourceUrl) : null
  const label = host ?? s.label
  return host ? (
    <a className="mimir-chip" data-source={dim.source} href={dim.sourceUrl} target="_blank" rel="noreferrer noopener" {...tipAttrs({ title: dim.sourceTitle ?? host })}>
      <Icon name={s.icon} size={13} />
      <span>{label}</span>
    </a>
  ) : (
    <span className="mimir-chip" data-source={dim.source}>
      <Icon name={s.icon} size={13} />
      {label}
    </span>
  )
}

/** What the hint line says for the row being edited, or for the sheet. */
function hintFor(dim: PilotDim | undefined, mode: 'confirm' | 'drive', tied: boolean): string {
  if (!dim) return mode === 'confirm' ? 'Pick a row or a callout to change it. Enter saves, Escape puts it back.' : 'Rows tied to a step edit it in Model, like your own edit.'
  if (mode === 'drive' && !tied) return assistantText('This size shapes the sketch, so it needs a rebuild: ask mimir to build again with it.')
  const range = dim.min !== undefined && dim.max !== undefined ? ` ${dim.min} to ${dimText(dim, dim.max)}.` : ''
  const guess = mode === 'confirm' && dim.source === 'guess' ? ' A guess, so check it.' : ''
  return `${dim.note ? `${dim.note.replace(/\.$/, '')}.` : dim.label + '.'}${range}${guess}`
}

/** The sizes panel: a row per size, its number matching the callout, with the value, its unit and where it came from. */
function SheetPanel({ sheet, mode, editing, setEditing }: { sheet: PilotSheet; mode: 'confirm' | 'drive'; editing: string | null; setEditing: (k: string | null) => void }) {
  const actions = useSheetUi((s) => s.actions)
  const bound = useSheetUi((s) => s.shown?.bound ?? null)
  const live = useSheetUi((s) => s.live)
  const draft = useSheetUi((s) => s.draft)
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    setSending(false)
    setNote(null)
  }, [sheet.id])
  const valueOf = (d: PilotDim): number => (mode === 'confirm' ? (draft[d.key] ?? d.value) : (live[d.key] ?? d.value))
  const changed = (d: PilotDim): boolean => valueOf(d) !== d.value
  const guesses = sheet.dims.filter((d) => d.source === 'guess' && !changed(d)).length
  const tied = (key: string): boolean => bound?.binds.some((b) => b.key === key) ?? false
  const dim = sheet.dims.find((d) => d.key === editing)
  const counts = (['asked', 'lookup', 'photo', 'guess'] as const).map((s) => [s, sheet.dims.filter((d) => d.source === s).length] as const).filter(([, n]) => n > 0)
  const commit = async (d: PilotDim, v: number) => {
    if (mode === 'confirm') {
      setDraft(d.key, v)
      return
    }
    if (!actions || !bound) return
    const before = valueOf(d)
    setLive(d.key, v)
    const out = await actions.drive(bound, d.key, v, before)
    // a failed edit shows the old size, which the design holds again, unless the edit could not be put back
    if (!out.ok) setLive(d.key, out.value ?? before)
    // the engine's own words for a refused edit go to the dev log; the note says it plainly
    if (!out.ok && out.detail) console.info(`sheet edit refused: ${out.detail}`)
    setNote({ ok: out.ok, text: out.summary })
  }
  const hint = note && mode === 'drive' ? note.text : hintFor(dim, mode, dim ? tied(dim.key) : false)
  // every hint this sheet can show: the line takes the tallest of them, one line or two, so moving between rows never
  // moves the rows or the footer, and a sheet whose hints all fit one line keeps one line
  const room = [...new Set([hintFor(undefined, mode, false), ...sheet.dims.filter((d) => mode === 'confirm' || tied(d.key)).map((d) => hintFor(d, mode, tied(d.key))), ...(note && mode === 'drive' ? [note.text] : [])])]
  return (
    <aside
      className="mimir-sheet-panel"
      data-testid="mimir-sheet-panel"
      data-mode={mode}
      aria-label={`${sheet.title}, sizes`}
      tabIndex={-1}
      onKeyDown={(e) => {
        // Escape puts away the panel the person opened after the build, from a field (whose typing it drops) or a
        // button; a waiting sheet's panel is its question and stays until it is answered
        if (e.key !== 'Escape' || mode !== 'drive' || e.defaultPrevented) return
        e.preventDefault()
        e.stopPropagation()
        closeSheet()
      }}
    >
      <header className="mimir-sheet-head">
        <h3>{mode === 'confirm' ? 'Sizes' : sheet.title}</h3>
        <p>{mode === 'confirm' ? 'Numbers match the callouts in the drawing.' : 'Change a size to edit its step.'}</p>
        <div className="mimir-sheet-tally" hidden={mode === 'drive'}>
          {counts.map(([s, n]) => (
            <span key={s} className="mimir-chip" data-source={s}>
              {n} {s === 'asked' ? 'asked' : s === 'lookup' ? 'looked up' : s === 'photo' ? 'from a photo' : n === 1 ? 'guess' : 'guesses'}
            </span>
          ))}
        </div>
      </header>
      <ol className="mimir-sheet-rows">
        {sheet.dims.map((d, i) => {
          const disabled = sending || (mode === 'drive' && !tied(d.key))
          return (
            <li
              key={d.key}
              className="mimir-sheet-row"
              data-testid="mimir-sheet-row"
              data-key={d.key}
              data-guess={(mode === 'confirm' && d.source === 'guess' && !changed(d)) || undefined}
              data-on={editing === d.key || undefined}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest('input, a')) return
                e.preventDefault()
                focusRow(sheet.id, d.key)
              }}
            >
              <span className="mimir-badge" data-source={d.source} aria-hidden="true">
                {i + 1}
              </span>
              <label className="mimir-sheet-label" htmlFor={fieldId(sheet.id, d.key)}>
                <span>{d.label}</span>
                <span className="mimir-sheet-unit">{dimUnit(d).unit}</span>
              </label>
              <span
                className="mimir-sheet-field"
                onFocus={() => setEditing(d.key)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEditing(null)
                }}
              >
                <ScrubNumber
                  id={fieldId(sheet.id, d.key)}
                  value={valueOf(d)}
                  ariaLabel={dimUnit(d).word ? `${d.label}, ${dimUnit(d).word}` : d.label}
                  digits={2}
                  step={dimUnit(d).step}
                  disabled={disabled}
                  onCommit={(v) => void commit(d, dimUnit(d).unit === '' ? wholeCount(v, d.min, d.max) : v)}
                  {...(d.min !== undefined ? { min: d.min } : {})}
                  {...(d.max !== undefined ? { max: d.max } : {})}
                />
              </span>
              <Chip dim={d} changed={changed(d)} />
            </li>
          )
        })}
      </ol>
      <p className="mimir-sheet-hint" data-bad={(note && !note.ok && mode === 'drive') || undefined}>
        <span data-testid="mimir-sheet-hint" aria-live="polite">
          {hint}
        </span>
        {room.map((t) => (
          <span key={t} className="mimir-sheet-hint-room" aria-hidden="true">
            {t}
          </span>
        ))}
      </p>
      <footer className="mimir-sheet-foot">
        <span className="mimir-sheet-msg">{mode === 'confirm' ? (guesses ? `${guesses} ${guesses === 1 ? 'guess' : 'guesses'} to check` : 'Every size checked') : bound ? `Tied to ${bound.binds.length} step${bound.binds.length === 1 ? '' : 's'}` : ''}</span>
        {mode === 'confirm' ? (
          <>
            <Button
              size="sm"
              data-testid="mimir-sheet-cancel"
              disabled={sending || !actions}
              onClick={() => {
                setSending(true)
                void actions?.cancel(sheet.id).catch(() => setSending(false))
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon="check"
              data-testid="mimir-sheet-build"
              disabled={sending || !actions}
              onClick={() => {
                setSending(true)
                void actions?.confirm(sheet.id, Object.fromEntries(sheet.dims.map((d) => [d.key, valueOf(d)]))).catch(() => setSending(false))
              }}
            >
              Build
            </Button>
          </>
        ) : (
          <Button size="sm" data-testid="mimir-sheet-close" onClick={closeSheet}>
            Done
          </Button>
        )}
      </footer>
    </aside>
  )
}

/** The sheet over the mimir tab's view: the drawing and panel while a sheet waits, the panel alone when asked for after the build. */
export function MimirSheet() {
  const shown = useSheetUi((s) => s.shown)
  const mode = useSheetUi(sheetMode)
  const picture = useSheetPicture(mode === 'confirm' ? (shown?.sheet ?? null) : null)
  const [editing, setEditing] = useState<string | null>(null)
  useEffect(() => setEditing(null), [shown?.sheet.id])
  // while the drawing is up, the record's rows are the fields: a focused row lights its callout
  const sheetId = shown?.sheet.id
  useEffect(() => {
    if (!sheetId) return
    const prefix = recordId(sheetId, '')
    const on = (e: FocusEvent) => {
      const id = (e.target as HTMLElement | null)?.id ?? ''
      if (id.startsWith(prefix)) setEditing(id.slice(prefix.length))
    }
    const off = (e: FocusEvent) => {
      if ((e.target as HTMLElement | null)?.id?.startsWith(prefix)) setEditing(null)
    }
    document.addEventListener('focusin', on)
    document.addEventListener('focusout', off)
    return () => {
      document.removeEventListener('focusin', on)
      document.removeEventListener('focusout', off)
    }
  }, [sheetId])
  // the view's own menus give way to the drawing; the timeline and lookups stop at the panel
  useEffect(() => {
    const vp = document.querySelector<HTMLElement>('.studio > .vp')
    if (!vp) return
    if (mode) vp.dataset['mimirSheet'] = mode === 'confirm' && picture ? 'drawing' : 'panel'
    else delete vp.dataset['mimirSheet']
    return () => {
      delete vp.dataset['mimirSheet']
    }
  }, [mode, picture])
  const drawing = !!shown && mode === 'confirm' && picture !== null
  // On a phone the view is a strip over the chat and paints in a stacking context of its own, so a panel inside it sits
  // under the chat and its composer. There the panel takes the conversation's place in the chat column instead, between
  // its header and the composer, and the conversation comes back where it was once the panel closes.
  const phone = usePhoneLayout()
  const panelUp = !!shown && !!mode && !drawing
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => setSlot(phone && panelUp ? document.querySelector<HTMLElement>('[data-testid="mimir-chat"] .mimir-sheet-slot') : null), [phone, panelUp])
  if (!shown || !mode) return null
  if (drawing) return <SheetDrawing sheet={shown.sheet} picture={picture!} editing={editing} onPick={(k) => focusRow(shown.sheet.id, k)} />
  const panel = <SheetPanel sheet={shown.sheet} mode={mode} editing={editing} setEditing={setEditing} />
  if (!phone) return panel
  return slot ? createPortal(panel, slot) : null
}
