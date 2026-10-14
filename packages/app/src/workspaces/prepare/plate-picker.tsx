// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate picker: one row at the foot of the view with the previous plate, the plate in view (its thumbnail and name)
// and the next plate. The plate opens a sheet of every plate as thumbnails, with a search and a Not sliced filter, and
// the plate's settings and Add plate. Every width is fixed, so nothing moves as plates or slices change: names are cut
// in the middle to fit, with the full name in the tooltip. Shift+[ and Shift+] step through the plates.
import { Button, Icon, Kbd, keymapFor, Seg, tipAttrs, useDismiss, useHideToasts } from '@slicerx/ui'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { useLookChoice } from '../../first-run/look'
import { formatShortcut } from '../../lib/keys'
import { fitMiddle, textWidth } from '../../lib/mid-truncate'
import { addPlate, switchPlate } from '../../plate/plates'
import { filterPlates, plateRows, plateSubtitle, SLICE_STATE_LABEL, stepPlate, type PlateRow } from '../../plate/plate-step'
import { useApp, type PlateEntry } from '../../state/store'
import type { Bed } from '@slicerx/contracts'
import { platePicture } from '../preview/plate-render'
import { PlateThumb } from '../preview/plate-thumb'
import { PlateSettingsForm, slotsOnPlate } from './plate-list'

/**
 * Text cut in the middle to fit its own box, measured in its own font; the box's width never depends on the text. A
 * `lead` (a plate's number) goes before it in bold, uncut, and the text fits the room it leaves.
 */
export function MidText({ text, lead, className, lines = 1 }: { text: string; lead?: string; className?: string; lines?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const leadRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  const [font, setFont] = useState('')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const cs = getComputedStyle(el)
      const f = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const before = leadRef.current ? leadRef.current.offsetWidth + textWidth(' ', f) : 0
      // Over more than one line the text wraps at words, so it is given a little less than the lines' full width.
      setWidth(Math.max(1, lines > 1 ? el.clientWidth * lines * 0.86 - before : el.clientWidth - before))
      setFont(f)
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [lead, lines])
  // Before the first measure the whole name shows, clipped by the box; one frame later it is cut to fit.
  const shown = useMemo(() => (width > 0 && font ? fitMiddle(text, width, (t) => textWidth(t, font)) : text), [text, width, font])
  return (
    <span ref={ref} className={className ? `mid-text ${className}` : 'mid-text'} data-full={shown === text ? undefined : text}>
      {lead ? (
        <>
          <b ref={leadRef}>{lead}</b>{' '}
        </>
      ) : null}
      {shown}
    </span>
  )
}

/** The plates with what each one needs drawn: its rows, and each plate's objects for the thumbnail. */
function usePlateRows(): { rows: PlateRow[]; objectsOf: (id: string) => readonly PlateEntry[] } {
  const plates = useApp((s) => s.plates)
  const plate = useApp((s) => s.plate)
  const active = useApp((s) => s.activePlate)
  const slice = useApp((s) => s.slice)
  // Each finished slice can change another plate's kept slice, so the rows are read again after one.
  const done = useApp((s) => s.slicesDone)
  const rows = useMemo(() => plateRows({ plates, plate, activePlate: active, slice }), [plates, plate, active, slice, done])
  const objectsOf = useCallback((id: string) => (id === active ? plate : (plates.find((p) => p.id === id)?.objects ?? [])), [plates, plate, active])
  return { rows, objectsOf }
}

function useStepKeys(): { prev: string; next: string } {
  const choice = useLookChoice()
  const map = keymapFor(choice.id, choice.overrides?.keys ?? {})
  return { prev: map['plate.prev'] ? formatShortcut(map['plate.prev']) : '', next: map['plate.next'] ? formatShortcut(map['plate.next']) : '' }
}

/** The full name a tooltip shows: "Plate 4: Deck box shell, front half", or "Plate 4" when it has no name of its own. */
function fullName(r: Pick<PlateRow, 'name' | 'number'>): string {
  const sub = plateSubtitle(r.name, r.number)
  return sub ? `Plate ${r.number}: ${sub}` : `Plate ${r.number}`
}

const THUMB = 28

/**
 * "Plate N of M:" at its widest N for M plates. The lead keeps this much room (drawn hidden under it), so the name
 * after it never moves as N changes.
 */
function widestLead(count: number, named: boolean): string {
  return `Plate ${'8'.repeat(String(count).length)} of ${count}${named ? ':' : ''}`
}

export function PlatePicker() {
  const { rows, objectsOf } = usePlateRows()
  const bed = useApp((s) => s.bed)
  const [open, setOpen] = useState(false)
  const keys = useStepKeys()
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  // The grid covers where the toasts sit: they wait out of sight, time stopped, until it shuts.
  useHideToasts(open, 'plate-grid')
  const cur = rows.find((r) => r.shown) ?? rows[0]
  if (!cur) return null
  const i = cur.number - 1
  const prev = rows[i - 1]
  const next = rows[i + 1]
  const sub = plateSubtitle(cur.name, cur.number)
  return (
    <div ref={ref} className="plate-picker-wrap">
      {open ? <PlateSheet rows={rows} objectsOf={objectsOf} onClose={close} anchor={ref} /> : null}
      <div className="plate-picker sx-overlay" data-testid="plate-picker" role="group" aria-label="Plate">
        <button
          type="button"
          className="pp-step"
          data-testid="plate-picker-prev"
          aria-label="Previous plate"
          disabled={!prev}
          onClick={() => void stepPlate(-1)}
          {...tipAttrs(prev ? { title: 'Previous plate', body: fullName(prev), ...(keys.prev ? { key: keys.prev } : {}) } : { title: 'Previous plate', body: 'This is the first plate.' })}
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <button
          type="button"
          className="pp-main"
          data-testid="plate-picker-current"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${fullName(cur)}, ${cur.number} of ${rows.length}. Show all plates`}
          onClick={() => setOpen((o) => !o)}
          {...tipAttrs({ title: fullName(cur), body: `${cur.objects} ${cur.objects === 1 ? 'object' : 'objects'}, ${SLICE_STATE_LABEL[cur.state].toLowerCase()}. Click for all plates.` })}
        >
          <span className="pp-thumb" aria-hidden="true">
            <PlateThumb objects={objectsOf(cur.id)} bed={bed} size={THUMB} fit />
          </span>
          <span className="pp-lead" data-widest={widestLead(rows.length, !!sub)}>
            <span>
              <b className="pp-no">Plate {cur.number}</b> <span className="pp-of">of {rows.length}</span>
              {sub ? ':' : null}
            </span>
          </span>
          <MidText className="pp-name" text={sub} />
          <Icon name="chevron-up" size={14} />
        </button>
        <button
          type="button"
          className="pp-step"
          data-testid="plate-picker-next"
          aria-label="Next plate"
          disabled={!next}
          onClick={() => void stepPlate(1)}
          {...tipAttrs(next ? { title: 'Next plate', body: fullName(next), ...(keys.next ? { key: keys.next } : {}) } : { title: 'Next plate', body: 'This is the last plate.' })}
        >
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
    </div>
  )
}

type Filter = 'all' | 'not-sliced'
const FILTERS = [
  { value: 'all', label: 'All', testId: 'plate-sheet-all' },
  { value: 'not-sliced', label: 'Not sliced', testId: 'plate-sheet-not-sliced' },
] as const

/** The most the sheet may take: up to 480 px, and never into the toolbar's lane at the top of the view. */
function sheetRoom(anchor: HTMLElement | null): number {
  const vp = anchor?.closest('.vp')
  if (!anchor || !vp) return 480
  const top = anchor.getBoundingClientRect().top
  const lane = vp.querySelector('.plate-tools-group:not([data-moved])')?.getBoundingClientRect().bottom ?? vp.getBoundingClientRect().top
  return Math.max(160, Math.min(480, Math.floor(top - lane - 16)))
}

/**
 * Tile sizes in the sheet (app.css .pp-grid and .pp-card): square thumbnails big enough to tell parts apart, four
 * across. The grid shows at most two and a half rows (BODY_MAX) and scrolls inside, so more plates never grow the sheet.
 */
const CARD = { min: 120, height: 140, gap: 8 }
/** The picture a tile draws, in pixels: twice the size it shows at, so it stays sharp on a dense screen. */
const PICTURE = { width: 256, height: 160 }
const BODY_MAX = 2 * CARD.height + 2 * CARD.gap + CARD.height / 2
const CHROME = 8 * 2 + 30 + 32 + 6 * 2 + 4 * 2

/**
 * The sheet's height for `count` plates at `width` px: room for every plate (not just the ones a search keeps, so
 * typing or filtering never resizes it) up to two and a half rows, and up to `room`. The plate settings form gets at
 * least 320 px.
 */
export function sheetHeight(count: number, width: number, room: number, form = false): number {
  const cols = Math.min(4, Math.max(1, Math.floor((width - 24 + CARD.gap) / (CARD.min + CARD.gap))))
  const rows = Math.max(1, Math.ceil(count / cols))
  const want = CHROME + Math.min(BODY_MAX, rows * CARD.height + (rows - 1) * CARD.gap)
  return Math.min(room, Math.max(form ? 320 : 0, want))
}

/**
 * A tile's picture: the plate's objects drawn shaded (plate-render.ts), once per plate and kept. Until it is drawn,
 * and on a plate with nothing on it, the tile shows the plate's outline thumbnail.
 */
function TilePicture({ objects, bed }: { objects: readonly PlateEntry[]; bed: Bed }) {
  const [, redraw] = useState(0)
  const url = objects.length ? platePicture(objects, PICTURE.width, PICTURE.height, () => redraw((n) => n + 1)) : null
  return (
    <span className="pp-card-thumb" aria-hidden="true" data-drawn={url ? '' : undefined}>
      {url ? <img src={url} alt="" draggable={false} /> : <PlateThumb objects={objects} bed={bed} size={64} fit />}
    </span>
  )
}

function PlateSheet({ rows, objectsOf, onClose, anchor }: { rows: PlateRow[]; objectsOf: (id: string) => readonly PlateEntry[]; onClose: () => void; anchor: RefObject<HTMLDivElement | null> }) {
  const bed = useApp((s) => s.bed)
  const activeObjects = useApp((s) => s.plate)
  const plates = useApp((s) => s.plates)
  const active = useApp((s) => s.activePlate)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState(false)
  const [room, setRoom] = useState(480)
  const [width, setWidth] = useState(640)
  const box = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = filterPlates(rows, query, filter === 'not-sliced')
  const meta = plates.find((p) => p.id === active)
  const slots = slotsOnPlate(activeObjects)

  useLayoutEffect(() => {
    setRoom(sheetRoom(anchor.current))
    setWidth(box.current?.clientWidth ?? 640)
    search.current?.focus({ preventScroll: true })
  }, [anchor])
  const height = sheetHeight(rows.length, width, room, editing)
  // The shown plate's card is scrolled into view when the sheet opens.
  useEffect(() => {
    anchor.current?.querySelector('.pp-card[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [anchor])

  const pick = (id: string) => {
    switchPlate(id)
    onClose()
  }
  // "/" goes to the search from anywhere in the sheet; Enter in it shows the first plate found.
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === '/' && e.target !== search.current) {
      e.preventDefault()
      search.current?.focus()
    }
  }
  return (
    <div ref={box} className="pp-sheet sx-overlay" role="dialog" aria-label="Plates" data-testid="plate-sheet" style={{ height }} onKeyDown={onKey}>
      <div className="pp-find">
        <label className="pp-search">
          <Icon name="search" size={15} />
          <input
            ref={search}
            type="search"
            className="pp-search-input"
            placeholder="Find a plate"
            aria-label="Find a plate"
            data-testid="plate-sheet-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && list[0]) pick(list[0].id)
            }}
          />
          <Kbd>/</Kbd>
        </label>
        <Seg size="sm" label="Show" value={filter} onChange={setFilter} options={FILTERS} />
      </div>
      {editing && meta ? (
        <div className="pp-body pp-form">
          <PlateSettingsForm key={meta.id} plate={meta} slots={slots} canDelete={plates.length > 1} onDone={() => setEditing(false)} />
        </div>
      ) : (
        <div className="pp-body">
          {list.length ? (
            <ul className="pp-grid" aria-label="Plates">
              {list.map((r) => (
                <li key={r.id}>
                  <button type="button" className="pp-card" aria-current={r.shown ? 'true' : undefined} data-state={r.state} onClick={() => pick(r.id)} {...tipAttrs({ title: fullName(r), body: `${r.objects} ${r.objects === 1 ? 'object' : 'objects'}, ${SLICE_STATE_LABEL[r.state].toLowerCase()}.` })}>
                    <TilePicture objects={objectsOf(r.id)} bed={bed} />
                    <MidText className="pp-card-name" lines={2} lead={String(r.number)} text={plateSubtitle(r.name, r.number) || `Plate ${r.number}`} />
                    <small className="pp-card-state">{SLICE_STATE_LABEL[r.state]}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pp-none">{filter === 'not-sliced' && !query ? 'Every plate with objects is sliced.' : 'No plate matches.'}</p>
          )}
        </div>
      )}
      <div className="pp-foot">
        <span className="pp-count">
          {list.length === rows.length ? `${rows.length} ${rows.length === 1 ? 'plate' : 'plates'}` : `${list.length} of ${rows.length} plates`}
        </span>
        <Button size="sm" variant="ghost" icon="settings" pressed={editing} onClick={() => setEditing((v) => !v)} tip="plate.settings">
          Plate settings
        </Button>
        <Button size="sm" variant="ghost" icon="new-plate" onClick={() => { addPlate(); onClose() }} tip="plate.add">
          Add plate
        </Button>
      </div>
    </div>
  )
}
