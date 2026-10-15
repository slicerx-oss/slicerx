// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension sheet in the mimir tab, laid out as a drawing: while a sheet waits, the view becomes a drawing sheet
// (front, right, top and iso, with a numbered callout for each size) and the sheet's record in the chat is where the
// sizes are typed, row numbers matching the callouts. Nothing builds until the record's build button. After the build
// a panel docked on the right comes back from the record, and editing a tied row there edits the step it set. Picking
// a callout picks its row and the other way round.
import { assistantText } from '@slicerx/contracts'
import type { PilotDim, PilotSheet } from '@slicerx/contracts'
import { Button, Icon, ScrubNumber, tipAttrs, type IconName } from '@slicerx/ui'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { arrowHead, drawView, fitScale, SHEET_VIEWS, VIEWS, type ViewName } from './sheet-draw'
import { closeSheet, setDraft, setLive, sheetMode, useSheetUi } from './sheet-ui'
import './mimir.css'

const SOURCE: Record<PilotDim['source'], { label: string; icon: IconName }> = {
  asked: { label: 'You said', icon: 'comment' },
  lookup: { label: 'Looked up', icon: 'globe' },
  photo: { label: 'Photo', icon: 'camera' },
  guess: { label: 'Guess', icon: 'help' },
}

const unitText = (u: PilotDim['unit']): string => (u === 'deg' ? '°' : u)

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

/** Room around a view's drawing for its view label and callouts, in px. */
const PAD = 24

/** The drawing: four views in a 2 x 2 frame, the flat ones at one scale, its title, units and state on the frame's bottom edge. */
function SheetDrawing({ sheet, editing, onPick }: { sheet: PilotSheet; editing: string | null; onPick: (key: string) => void }) {
  // a guess stays marked until its row is typed in or kept with Enter
  const draft = useSheetUi((s) => s.draft)
  const assumed = (key: string): boolean => sheet.dims.some((d) => d.key === key && d.source === 'guess') && !(key in draft)
  const ref = useRef<HTMLDivElement>(null)
  const [cell, setCell] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setCell({ w: Math.max(80, Math.floor(r.width / 2)), h: Math.max(60, Math.floor(r.height / 2)) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const part = sheet.part ?? []
  const views = useMemo(() => {
    if (!cell) return null
    // the flat views share one scale, as a print drawing does; the iso view fits its own cell
    const flat = Math.min(...SHEET_VIEWS.filter((v) => v !== 'iso').map((v) => fitScale(part, sheet.dims, v, cell.w, cell.h, PAD, sheet.views)))
    return SHEET_VIEWS.map((v) => ({ v, drawn: drawView(part, sheet.dims, v, cell.w, cell.h, { pad: PAD, order: sheet.views, ...(v === 'iso' ? {} : { scale: flat }) }) }))
  }, [cell, part, sheet.dims, sheet.views])
  return (
    <div className="mimir-drawing" data-testid="mimir-sheet-drawing">
      <div className="mimir-drawing-card">
      <div className="mimir-drawing-head">
        <span className="mimir-drawing-title sx-mono">Drawing, four views</span>
      </div>
      <div ref={ref} className="mimir-drawing-grid">
        {views?.map(({ v, drawn }) => (
          <div key={v} className="mimir-drawing-cell" data-view={v}>
            <svg width={cell!.w} height={cell!.h} viewBox={`0 0 ${cell!.w} ${cell!.h}`} role="img" aria-label={`${sheet.title}, ${VIEWS[v].label}`}>
              {drawn.faces.map((f, i) => (
                <path key={i} className="mimir-drawing-face" d={f.path} fillRule="evenodd" style={{ fill: `color-mix(in srgb, var(--sheet-part) ${f.light}%, var(--sheet-part-dark))` }} />
              ))}
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
                const dim = sheet.dims.find((x) => x.key === d.key)!
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
        <span>Not built yet</span>
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
  const range = dim.min !== undefined && dim.max !== undefined ? ` ${dim.min} to ${dim.max} ${unitText(dim.unit)}.` : ''
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
    const out = await actions.drive(bound, d.key, v)
    if (!out.ok) setLive(d.key, before)
    setNote({ ok: out.ok, text: out.summary })
  }
  const hint = note && mode === 'drive' ? note.text : hintFor(dim, mode, dim ? tied(dim.key) : false)
  return (
    <aside className="mimir-sheet-panel" data-testid="mimir-sheet-panel" data-mode={mode} aria-label={`${sheet.title}, sizes`} tabIndex={-1}>
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
                <span className="mimir-sheet-unit">{unitText(d.unit)}</span>
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
                  ariaLabel={`${d.label}, ${d.unit === 'deg' ? 'degrees' : d.unit === '%' ? 'percent' : 'millimeters'}`}
                  digits={2}
                  step={d.unit === 'deg' ? 1 : 0.5}
                  disabled={disabled}
                  onCommit={(v) => void commit(d, v)}
                  {...(d.min !== undefined ? { min: d.min } : {})}
                  {...(d.max !== undefined ? { max: d.max } : {})}
                />
              </span>
              <Chip dim={d} changed={changed(d)} />
            </li>
          )
        })}
      </ol>
      <p className="mimir-sheet-hint" data-testid="mimir-sheet-hint" data-bad={(note && !note.ok && mode === 'drive') || undefined} aria-live="polite">
        {hint}
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
    if (mode) vp.dataset['mimirSheet'] = mode === 'confirm' && shown?.sheet.part?.length ? 'drawing' : 'panel'
    else delete vp.dataset['mimirSheet']
    return () => {
      delete vp.dataset['mimirSheet']
    }
  }, [mode, shown?.sheet.part?.length])
  if (!shown || !mode) return null
  const drawing = mode === 'confirm' && (shown.sheet.part?.length ?? 0) > 0
  return (
    <>
      {drawing ? <SheetDrawing sheet={shown.sheet} editing={editing} onPick={(k) => focusRow(shown.sheet.id, k)} /> : <SheetPanel sheet={shown.sheet} mode={mode} editing={editing} setEditing={setEditing} />}
    </>
  )
}
