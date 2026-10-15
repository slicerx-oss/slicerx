// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Preview layer slider with its marks. A + beside it and a right-click on it add a pause, a color change or
// custom G-code at the start of a layer: the + at the top layer, a right-click at the layer under the pointer. Marks
// are pins over the track, each on a stem down to its layer, and pins too close to tell apart step up into lanes; past
// three lanes they share a "+N" pin that lists them. A click on a pin jumps there and offers to edit or remove it. A
// color change can note the filament slot to load; the note is saved with the project and does not change the G-code.
// The marks go into the next slice as layer G-code.
import { Button, Dialog, Field, Icon, Menu, MenuAnchor, MenuHeading, MenuItem, MenuSeparator, Range, Textarea, tipAttrs, type IconName } from '@slicerx/ui'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { resolveSlots } from '../../filament/slots'
import { Swatch } from '../../parts'
import { addMark, customGcodeProblem, MARK_LABEL, MARK_Z_TOL, nextSlot, removeMark, setMarkSlot, type LayerMark, type MarkKind } from '../../plate/layer-marks'
import { toast, useApp } from '../../state/store'
import { TrackStrikes } from './strike-slots'

const EMPTY: LayerMark[] = []
const EMPTY_IDS: readonly string[] = []
/** Pins in one lane keep their centers this many pixels apart, so heads and their rings never touch. */
const PIN_GAP = 26
/** A pin in another lane keeps its center this far from a head, so no stem runs through another lane's head. */
const PIN_CLEAR = 17
/** Lanes over the track; the bar keeps room for this many, so a new pin never moves anything. */
export const PIN_LANES = 3
/** Half the layer slider's thumb: the first and last layers sit this far in from the track's ends. */
const THUMB_R = 6.5

/** The foot of a moved pin's stem steps back to its layer at one of these heights over the track's center, in px. */
const ELBOW_TOP = 7
const ELBOW_LOW = 2

/** Where one pin goes: its lane, how far its head sits right of its layer (px), the height its foot steps back at, and
 * `into`, the pin whose head holds it when every lane is taken (-1 when it has a head of its own). */
export interface PinPlace {
  lane: number
  off: number
  elbow: number
  into: number
}

/**
 * The lane of each pin, how far its head sits right of its layer, and the height its stem steps back at, given its
 * share along the track and the track length in px: lane 0 just over the track, then one up per crowded neighbor, up
 * to `lanes`. A pin with every lane taken gets no head of its own: it joins the head placed last (the one furthest
 * right), which then stands for all of them as a "+N" pin that lists them. A head that would sit on another pin's
 * stem, or a stem that would run through another lane's head, moves right; its stem then steps back left to its layer
 * just above the track. Heads keep the order of their layers, and in a crowd the head furthest right steps back
 * lowest, so the feet nest and no two stems cross. Pins at the same share keep the order of `keys` (else their
 * index), so the layout depends only on the marks and the track length, never on render order.
 */
export function pinLayout(shares: readonly number[], trackPx: number, lanes = PIN_LANES, keys?: readonly string[]): PinPlace[] {
  const out: PinPlace[] = shares.map(() => ({ lane: 0, off: 0, elbow: ELBOW_TOP, into: -1 }))
  if (trackPx <= 0) return out
  const order = shares.map((_, i) => i).sort((a, b) => shares[a]! - shares[b]! || (keys ? (keys[a]! < keys[b]! ? -1 : keys[a]! > keys[b]! ? 1 : 0) : 0) || a - b)
  const last: number[] = []
  const heads: { lane: number; x: number }[] = []
  // runs of pins whose feet overlap: a pin whose layer is left of an earlier head, or within a stem's width of it, joins
  const runs: number[][] = []
  let right = -Infinity
  // the pin whose head was placed last, which a pin with no lane joins
  let lastHead = -1
  for (const i of order) {
    const at = shares[i]! * trackPx
    let lane = last.findIndex((l) => at - l >= PIN_GAP)
    if (lane < 0 && last.length < lanes) lane = last.length
    if (lane < 0) {
      out[i] = { ...out[lastHead]!, into: lastHead }
      continue
    }
    // never left of an earlier head, so the heads keep their layers' order
    let x = Math.max(at, right)
    for (let moved = true; moved; ) {
      moved = false
      for (const h of heads) {
        const gap = h.lane === lane ? PIN_GAP : PIN_CLEAR
        // a hair under the gap, so a head already pushed to it never counts as too near again
        if (Math.abs(x - h.x) < gap - 0.01) (x = h.x + gap), (moved = true)
      }
    }
    if (at < right + 2 && runs.length) runs[runs.length - 1]!.push(i)
    else runs.push([i])
    right = Math.max(right, x)
    heads.push({ lane, x })
    last[lane] = x
    lastHead = i
    out[i] = { lane, off: Math.round((x - at) * 10) / 10, elbow: ELBOW_TOP, into: -1 }
  }
  // in each run the moved heads step back one under another, the first highest
  for (const run of runs) {
    const moved = run.filter((i) => out[i]!.off > 0)
    const step = moved.length > 1 ? Math.min(2.5, (ELBOW_TOP - ELBOW_LOW) / (moved.length - 1)) : 0
    moved.forEach((i, k) => (out[i]!.elbow = ELBOW_TOP - k * step))
  }
  // a pin held by another head takes that head's place
  for (const p of out) if (p.into >= 0) Object.assign(p, { ...out[p.into]!, into: p.into })
  return out
}

/** The lane of each pin (see pinLayout). */
export function pinLanes(shares: readonly number[], trackPx: number, lanes = PIN_LANES): number[] {
  return pinLayout(shares, trackPx, lanes).map((p) => p.lane)
}

/**
 * The layer slot nearest a point on the track: a mark always lands on a layer, never between two. The track is spaced
 * by layer number, not height, so a plate with layers of different heights still has one slot per sliced layer; the
 * height comes from the sliced layer list after. A point exactly halfway between two slots goes to the upper one, and
 * a point past either end goes to the first or last layer.
 */
export function layerAtPoint(clientX: number, track: { left: number; width: number }, n: number): number {
  if (n <= 1) return 1
  const span = Math.max(1, track.width - 2 * THUMB_R)
  const share = Math.max(0, Math.min(1, (clientX - track.left - THUMB_R) / span))
  return Math.round(share * (n - 1)) + 1
}

/** A pin head on screen: its center, its layer and height, and the marks it stands for (more than one for a "+N" pin). */
export interface PinHead {
  x: number
  y: number
  layer: number
  z: number
  ids: readonly string[]
}

/** A finger picks among the heads whose centers are this close to the tap (px); two or more open a list. */
export const TOUCH_R = 22

/**
 * The heads a pointer at (x, y) picks, nearest first, ties to the lower layer, then the lower height, then the first
 * mark id. A mouse or pen picks the nearest head only, so where two pins' hit areas meet the nearer head wins and no
 * point belongs to two pins. A finger picks every head within TOUCH_R: one is that pin, more than one opens a list of
 * them, and none is no pick.
 */
export function pinsAt(x: number, y: number, heads: readonly PinHead[], touch: boolean): PinHead[] {
  const by = heads
    .map((h) => ({ h, d: Math.hypot(h.x - x, h.y - y) }))
    .sort((a, b) => a.d - b.d || a.h.layer - b.h.layer || a.h.z - b.h.z || ((a.h.ids[0] ?? '') < (b.h.ids[0] ?? '') ? -1 : 1))
  if (!touch) return by.slice(0, 1).map((e) => e.h)
  return by.filter((e) => e.d <= TOUCH_R).map((e) => e.h)
}

/** The width pins spread over: the track less the thumb at each end, kept current as it resizes. */
function useSpan(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  // a passive effect: the track's ref is attached after this child's layout effects run
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setW(Math.max(0, el.clientWidth - 2 * THUMB_R))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}
const ICON: Record<MarkKind, IconName> = { pause: 'pause-marker', color_change: 'color-change-marker', custom: 'terminal' }
const HINT: Record<MarkKind, string> = {
  pause: 'Insert a pause command at the beginning of this layer.',
  color_change: 'Stop at the beginning of this layer so you can change the filament.',
  custom: 'Insert custom G-code at the beginning of this layer.',
}
/** What a slot on a color change means today, said wherever the slot is picked. */
const SLOT_NOTE = 'The slot is a note saved with the project. The print still pauses here for you to swap the filament by hand.'

interface SlotRow {
  index: number
  color: string
  type: string
}
/** The loaded filament slots, by their number, color and material; read through one string so the selector stays stable. */
function useSlotRows(): SlotRow[] {
  const key = useApp((s) => resolveSlots(s).map((r) => `${r.index}|${r.color}|${r.type}`).join(';'))
  return useMemo(() => (key ? key.split(';').map((r) => { const [index, color, type] = r.split('|'); return { index: Number(index), color: color ?? '', type: type ?? '' } }) : []), [key])
}

/** Layer number (1-based) a mark sits on: the first layer whose top reaches its height, as the engine places it. */
export function layerOf(m: Pick<LayerMark, 'z'>, layerZ: ArrayLike<number>): number {
  for (let i = 0; i < layerZ.length; i++) if ((layerZ[i] ?? 0) >= m.z - MARK_Z_TOL) return i + 1
  return layerZ.length
}

/** A mark's name for screen readers and menus: "Color change at layer 20, 3.75 mm". */
export function markName(m: Pick<LayerMark, 'kind'>, layer: number, layerZ: ArrayLike<number>): string {
  return `${MARK_LABEL[m.kind]} at layer ${layer}, ${(layerZ[layer - 1] ?? 0).toFixed(2)} mm`
}

/**
 * The marks menu while open: where (`at`, or under the + when null), the layer it is for, and the marks it shows: none
 * for the add menu, one for that mark's own menu, more for a list to pick one from. `from` gets the focus back when
 * the menu closes with nothing chosen.
 */
export type MarksMenu = { at: { x: number; y: number } | null; layer: number; ids: readonly string[]; from: HTMLElement | null } | null

/** Marks sorted the way pins are laid out: by layer, then height, then id. */
function byLayer(marks: readonly LayerMark[], layerZ: ArrayLike<number>): { m: LayerMark; layer: number }[] {
  return marks.map((m) => ({ m, layer: layerOf(m, layerZ) })).sort((a, b) => a.layer - b.layer || a.m.z - b.m.z || (a.m.id < b.m.id ? -1 : 1))
}

/**
 * The pause, color change and custom G-code pins over the layer slider; `x` is a layer's share along it. Every pin is
 * a button in layer order, so Tab walks them and Enter opens one. A mouse click goes to the nearest head, a tap to
 * every head near the finger (pinsAt), so crowded pins never route to a neighbor. `onPick` gets the marks picked and
 * the head's top left, where the menu opens.
 */
function LayerPins({ x, layerZ, track, selected, onPick }: { x: (layer: number) => number; layerZ: ArrayLike<number>; track: RefObject<HTMLElement | null>; selected: readonly string[]; onPick: (ids: readonly string[], at: { x: number; y: number }, from: HTMLElement) => void }) {
  const plateId = useApp((s) => s.activePlate)
  const marks = useApp((s) => s.layerMarks[plateId]) ?? EMPTY
  const slots = useSlotRows()
  const band = useRef<HTMLDivElement>(null)
  // the last press: its kind and where it went down, since a click made from a tap can carry other coordinates
  const pointer = useRef<{ type: string; x: number; y: number }>({ type: 'mouse', x: 0, y: 0 })
  const sorted = byLayer(marks, layerZ)
  const pins = pinLayout(sorted.map((e) => x(e.layer)), useSpan(track), PIN_LANES, sorted.map((e) => `${e.m.z.toFixed(4)} ${e.m.id}`))
  const held = sorted.map((_, i) => sorted.filter((__, j) => j === i || pins[j]!.into === i))
  /** Every head on screen, from the buttons themselves. */
  const heads = (): { head: PinHead; el: HTMLElement }[] =>
    Array.from(band.current?.parentElement?.querySelectorAll<HTMLElement>('.layer-mark[data-ids]') ?? []).map((el) => {
      const r = el.getBoundingClientRect()
      return { el, head: { x: r.left + r.width / 2, y: r.top + r.height / 2, layer: Number(el.dataset.layer), z: Number(el.dataset.z), ids: (el.dataset.ids ?? '').split(' ') } }
    })
  const open = (picked: { head: PinHead; el: HTMLElement }[]) => {
    if (!picked.length) return
    const r = picked[0]!.el.getBoundingClientRect()
    onPick(picked.flatMap((p) => p.head.ids), { x: r.left, y: r.top - 4 }, picked[0]!.el)
  }
  const act = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const all = heads()
    // Enter or Space on a focused pin: that pin
    const own = (e.target as HTMLElement).closest<HTMLElement>('.layer-mark[data-ids]')
    if (e.type === 'click' && e.detail === 0 && own) return open(all.filter((h) => h.el === own))
    const type = (e.nativeEvent as PointerEvent).pointerType || pointer.current.type
    const touch = type === 'touch'
    const at = touch ? pointer.current : { x: e.clientX, y: e.clientY }
    const near = pinsAt(at.x, at.y, all.map((h) => h.head), touch)
    // a tap on a pin always picks at least that pin
    open(near.length ? all.filter((h) => near.includes(h.head)) : all.filter((h) => h.el === own))
  }
  return (
    <>
      {/* on a touch screen the band over the track takes taps between pins too, and gives them to the heads near the finger */}
      <div ref={band} className="layer-pin-band" aria-hidden="true" onPointerDown={(e) => ((pointer.current = { type: e.pointerType, x: e.clientX, y: e.clientY }), e.stopPropagation())} onClick={act} />
      {sorted.map((e, i) => {
        const p = pins[i]!
        if (p.into >= 0) return null
        const group = held[i]!
        const { m, layer } = e
        const slot = m.kind === 'color_change' && m.slot ? slots.find((r) => r.index === m.slot) : undefined
        const color = group.length === 1 ? slot?.color : undefined
        const name = markName(m, layer, layerZ)
        const last = group[group.length - 1]!.layer
        const label = group.length > 1 ? `${group.length} layer actions, layers ${layer} to ${last}` : name
        const title = group.length > 1 ? `${group.length} layer actions here` : `Layer ${layer}, ${MARK_LABEL[m.kind]}`
        const body =
          group.length > 1
            ? `${group.map((g) => `${MARK_LABEL[g.m.kind]} at ${g.layer}`).join(', ')}. Click to pick one.`
            : m.kind === 'custom'
              ? (m.gcode ?? '').split('\n')[0]!.slice(0, 60)
              : m.kind === 'color_change' && m.slot
                ? `${slot ? `Slot ${m.slot}` : `Slot ${m.slot}, not loaded now`}, noted. The print pauses for a manual swap. Click to change or remove it.`
                : m.kind === 'color_change' && slots.length > 1
                  ? 'Click to note its filament or remove it.'
                  : 'Click to remove it.'
        const ids = group.map((g) => g.m.id)
        return (
          <button
            key={m.id}
            type="button"
            className="layer-mark"
            data-kind={group.length > 1 ? 'group' : m.kind}
            data-lane={p.lane}
            data-ids={ids.join(' ')}
            data-layer={layer}
            data-z={m.z}
            data-swatch={color ? '' : undefined}
            data-selected={ids.some((id) => selected.includes(id)) || undefined}
            // the tip opens over the bar's top edge, level with the pin and clear of the controls there, so it covers none of the bar's
            data-tip-above=".dock"
            data-tip-side="top"
            style={{ left: p.off ? `calc(${x(layer) * 100}% + ${p.off}px)` : `${x(layer) * 100}%`, ...(p.lane ? ({ '--lane': p.lane } as CSSProperties) : {}), ...(p.off ? ({ '--off': `${p.off}px`, '--jog': `${p.elbow}px` } as CSSProperties) : {}), ...(color ? ({ '--c': color } as CSSProperties) : {}) }}
            aria-label={label}
            aria-haspopup="menu"
            {...tipAttrs({ title, body })}
            onPointerDown={(ev) => ((pointer.current = { type: ev.pointerType, x: ev.clientX, y: ev.clientY }), ev.stopPropagation())}
            onClick={act}
            onContextMenu={act}
          >
            {group.length > 1 ? <span className="layer-mark-count">+{group.length}</span> : color ? null : <Icon name={ICON[m.kind]} size={12} />}
            {/* the foot of the stem: down to the track, stepping back left to the layer when the head sits right of it */}
            <span className="layer-mark-leg" aria-hidden="true" />
          </button>
        )
      })}
    </>
  )
}

/** The + button beside the layer slider, the marks menu, and the custom G-code dialog. */
function LayerMarksMenu({ top, layerZ, menu, setMenu, onJump }: { top: number; layerZ: ArrayLike<number>; menu: MarksMenu; setMenu: (m: MarksMenu) => void; onJump: (layer: number) => void }) {
  const plateId = useApp((s) => s.activePlate)
  const marks = useApp((s) => s.layerMarks[plateId]) ?? EMPTY
  const [custom, setCustom] = useState<{ text: string; z: number; layer: number } | null>(null)
  // "Add color change" with more than one slot first asks which filament it changes to.
  const [picking, setPicking] = useState(false)
  const slots = useSlotRows()
  const layer = menu?.layer ?? top
  const z = layerZ[layer - 1] ?? 0
  const shown = (menu?.ids ?? []).map((id) => marks.find((m) => m.id === id)).filter((m): m is LayerMark => !!m)
  const here = shown.length === 1 ? shown[0]! : null
  const hereLayer = here ? layerOf(here, layerZ) : layer
  /** Shuts the menu; `back` returns the focus to what opened it unless the person has moved it somewhere else. */
  const close = (back = true) => {
    const from = menu?.from
    setMenu(null)
    setPicking(false)
    const active = document.activeElement
    if (back && from?.isConnected && (!active || active === document.body || active.closest('[role="menu"]'))) from.focus()
  }
  const add = (kind: MarkKind, slot?: number) => {
    if (kind === 'color_change' && slot === undefined && slots.length > 1) return setPicking(true)
    close()
    if (kind === 'custom') return setCustom({ text: '', z, layer })
    addMark(z, kind, undefined, undefined, slot)
    toast(`${MARK_LABEL[kind]} added at layer ${layer}${slot ? ` (slot ${slot} noted)` : ''}. Slice again to put it in the file.`, 'info')
  }
  const fresh = nextSlot(z, marks, slots.length)
  const slotItems = (current: number | undefined, next: boolean, pick: (slot: number) => void) => (
    <>
      {slots.map((r) => (
        <MenuItem key={r.index} checked={current === r.index} aside={next && r.index === fresh ? 'next' : r.type} onClick={() => pick(r.index)}>
          <Swatch color={r.color} size="sm" /> Slot {r.index}
        </MenuItem>
      ))}
      {current && !slots.some((r) => r.index === current) ? (
        <MenuItem checked disabled aside="not loaded">
          Slot {current}
        </MenuItem>
      ) : null}
      <p className="lmarks-note">{SLOT_NOTE}</p>
    </>
  )
  const problem = custom ? customGcodeProblem(custom.text) : null
  const label = picking ? `Color change at layer ${layer}` : here ? `${MARK_LABEL[here.kind]} at layer ${hereLayer}` : shown.length > 1 ? `Layer actions near layer ${layer}` : `Layer ${layer} actions`
  return (
    <div className="lmarks-add">
      <MenuAnchor>
        <Button variant="ghost" size="sm" icon="plus" aria-haspopup="menu" aria-expanded={menu !== null && menu.at === null} aria-label="Add layer action" tip={{ title: 'Add layer action', body: 'Pause, change the filament or insert G-code at the top layer.', key: 'Right-click' }} onClick={(e) => (menu ? close() : setMenu({ at: null, layer: top, ids: marksOn(marks, top, layerZ), from: e.currentTarget }))} />
        <Menu key={`${picking ? 'pick' : 'main'} ${(menu?.ids ?? []).join(' ')}`} open={menu !== null} onClose={() => close()} label={label} align="end" at={menu?.at ?? undefined}>
          {picking ? (
            <>
              <MenuHeading>Change to</MenuHeading>
              {slotItems(fresh, true, (slot) => add('color_change', slot))}
            </>
          ) : shown.length > 1 ? (
            <>
              <MenuHeading>Pick one</MenuHeading>
              {byLayer(shown, layerZ).map(({ m, layer: l }) => (
                <MenuItem
                  key={m.id}
                  icon={ICON[m.kind]}
                  onClick={() => {
                    // that mark's own menu, at the same place
                    onJump(l)
                    setMenu(menu ? { ...menu, layer: l, ids: [m.id] } : null)
                  }}
                >
                  {markName(m, l, layerZ)}
                </MenuItem>
              ))}
            </>
          ) : here ? (
            <>
              {here.kind === 'color_change' && slots.length > 1 ? (
                <>
                  <MenuHeading>Change to</MenuHeading>
                  {slotItems(here.slot, false, (slot) => (setMarkSlot(here.id, slot), close()))}
                  <MenuSeparator />
                </>
              ) : null}
              {here.kind === 'custom' ? (
                <MenuItem icon="rename" onClick={() => { close(false); setCustom({ text: here.gcode ?? '', z: here.z, layer: hereLayer }) }}>
                  Edit custom G-code
                </MenuItem>
              ) : null}
              <MenuItem icon="delete" onClick={() => { removeMark(here.id); close() }}>
                {here.kind === 'pause' ? 'Remove pause' : here.kind === 'color_change' ? 'Remove color change' : 'Remove custom G-code'}
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem icon="pause-marker" {...tipAttrs({ title: 'Add pause', body: HINT.pause })} onClick={() => add('pause')}>
                Add pause
              </MenuItem>
              <MenuItem icon="color-change-marker" {...tipAttrs({ title: 'Add color change', body: HINT.color_change })} onClick={() => add('color_change')}>
                Add color change
              </MenuItem>
              <MenuItem icon="terminal" {...tipAttrs({ title: 'Add custom G-code', body: HINT.custom })} onClick={() => add('custom')}>
                Add custom G-code
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          <MenuItem disabled>
            Layer {here ? hereLayer : layer}, {(layerZ[(here ? hereLayer : layer) - 1] ?? 0).toFixed(2)} mm
          </MenuItem>
        </Menu>
      </MenuAnchor>
      <Dialog
        open={custom !== null}
        onClose={() => setCustom(null)}
        title={`Custom G-code at layer ${custom?.layer ?? layer}`}
        footer={
          <>
            <Button onClick={() => setCustom(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={problem !== null}
              onClick={() => {
                if (!custom) return
                try {
                  addMark(custom.z, 'custom', custom.text)
                  toast('Custom G-code added. Slice again to put it in the file.', 'info')
                  setCustom(null)
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Could not add it', 'error')
                }
              }}
            >
              Add
            </Button>
          </>
        }
      >
        <Field htmlFor="mark-gcode" label="G-code" hint="Runs at the start of this layer. The engine checks it again when it writes the file." {...(custom && custom.text && problem ? { error: problem } : {})}>
          <Textarea id="mark-gcode" rows={5} spellCheck={false} className="sx-mono" value={custom?.text ?? ''} onChange={(e) => setCustom(custom ? { ...custom, text: e.target.value } : custom)} />
        </Field>
      </Dialog>
    </div>
  )
}

/** The ids of the marks on `layer`, in layer order. */
function marksOn(marks: readonly LayerMark[], layer: number, layerZ: ArrayLike<number>): string[] {
  return byLayer(marks, layerZ).filter((e) => e.layer === layer).map((e) => e.m.id)
}

/**
 * The layer slider in the playback bar, its pins over it, and the + for the top layer. A pin click and a right-click
 * go through `onJump`, the same layer step a typed layer takes (playback stops), then open the marks menu there.
 */
export function LayerTrack({ id, n, top, layerZ, onChange, onJump, onKeyDown }: { id: string; n: number; top: number; layerZ: ArrayLike<number>; onChange: (layer: number) => void; onJump: (layer: number) => void; onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void }) {
  const [menu, setMenu] = useState<MarksMenu>(null)
  const rail = useRef<HTMLDivElement>(null)
  const plateId = useApp((s) => s.activePlate)
  const marks = useApp((s) => s.layerMarks[plateId]) ?? EMPTY
  const z = layerZ[top - 1] ?? 0
  const share = (layer: number) => (n > 1 ? (layer - 1) / (n - 1) : 0)
  return (
    <div
      className="layer-track"
      onContextMenu={(e) => {
        e.preventDefault()
        // over the track, the layer under the pointer; beside it (the +), the top layer
        const r = rail.current?.getBoundingClientRect()
        const layer = r && e.clientX >= r.left && e.clientX <= r.right ? layerAtPoint(e.clientX, r, n) : top
        if (layer !== top) onJump(layer)
        setMenu({ at: { x: e.clientX, y: e.clientY }, layer, ids: marksOn(marks, layer, layerZ), from: rail.current?.querySelector('input') ?? null })
      }}
    >
      <div className="layer-track-rail" ref={rail}>
        <Range id={id} className="thin" min={1} max={n} value={top} onChange={onChange} onKeyDown={onKeyDown} aria-valuetext={`Layer ${top} of ${n}, ${z.toFixed(2)} mm`} />
        <div className="layer-marks" data-testid="layer-pins">
          <TrackStrikes share={(layer: number) => share(layer) * 100} />
          <LayerPins
            x={share}
            layerZ={layerZ}
            track={rail}
            selected={menu && menu.ids.length === 1 ? menu.ids : EMPTY_IDS}
            onPick={(ids, at, from) => {
              const picked = byLayer(ids.map((i) => marks.find((m) => m.id === i)).filter((m): m is LayerMark => !!m), layerZ)
              if (!picked.length) return
              // one mark: its layer, then its menu; several: the list to pick one from, which jumps when one is picked
              if (picked.length === 1) onJump(picked[0]!.layer)
              setMenu({ at, layer: picked[0]!.layer, ids: picked.map((p) => p.m.id), from })
            }}
          />
        </div>
      </div>
      <LayerMarksMenu top={top} layerZ={layerZ} menu={menu} setMenu={setMenu} onJump={onJump} />
    </div>
  )
}
