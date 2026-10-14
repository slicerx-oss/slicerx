// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Preview layer slider with its marks. A + beside it and a right-click on it add a pause, a color change or
// custom G-code at the start of a layer: the + at the top layer, a right-click at the layer under the pointer. Marks
// are pins over the track, each on a stem down to its layer, and pins too close to tell apart step up into lanes. A
// click on a pin jumps there and offers to edit or remove it. A color change names the filament slot it goes to. The
// marks go into the next slice as layer G-code.
import { Button, Dialog, Field, Icon, Menu, MenuAnchor, MenuHeading, MenuItem, MenuSeparator, Range, Textarea, tipAttrs, type IconName } from '@slicerx/ui'
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { resolveSlots } from '../../filament/slots'
import { Swatch } from '../../parts'
import { addMark, customGcodeProblem, MARK_LABEL, nextSlot, removeMark, setMarkSlot, type LayerMark, type MarkKind } from '../../plate/layer-marks'
import { toast, useApp } from '../../state/store'
import { TrackStrikes } from './strike-slots'

const EMPTY: LayerMark[] = []
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

/**
 * The lane of each pin, how far its head sits right of its layer, and the height its stem steps back at, given its
 * share along the track and the track length in px: lane 0 just over the track, then one up per crowded neighbor, up
 * to `lanes`; a pin with every lane taken goes where the last pin is furthest back. A head that would sit on another
 * pin's stem, or a stem that would run through another lane's head, moves right; its stem then steps back left to its
 * layer just above the track. Heads keep the order of their layers, and in a crowd the head furthest right steps back
 * lowest, so the feet nest and no two stems cross.
 */
export function pinLayout(shares: readonly number[], trackPx: number, lanes = PIN_LANES): { lane: number; off: number; elbow: number }[] {
  const out = shares.map(() => ({ lane: 0, off: 0, elbow: ELBOW_TOP }))
  if (trackPx <= 0) return out
  const order = shares.map((_, i) => i).sort((a, b) => shares[a]! - shares[b]!)
  const last: number[] = []
  const heads: { lane: number; x: number }[] = []
  // runs of pins whose feet overlap: a pin whose layer is left of an earlier head, or within a stem's width of it, joins
  const runs: number[][] = []
  let right = -Infinity
  for (const i of order) {
    const at = shares[i]! * trackPx
    let lane = last.findIndex((l) => at - l >= PIN_GAP)
    if (lane < 0) lane = last.length < lanes ? last.length : last.indexOf(Math.min(...last))
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
    out[i] = { lane, off: Math.round((x - at) * 10) / 10, elbow: ELBOW_TOP }
  }
  // in each run the moved heads step back one under another, the first highest
  for (const run of runs) {
    const moved = run.filter((i) => out[i]!.off > 0)
    const step = moved.length > 1 ? Math.min(2.5, (ELBOW_TOP - ELBOW_LOW) / (moved.length - 1)) : 0
    moved.forEach((i, k) => (out[i]!.elbow = ELBOW_TOP - k * step))
  }
  return out
}

/** The lane of each pin (see pinLayout). */
export function pinLanes(shares: readonly number[], trackPx: number, lanes = PIN_LANES): number[] {
  return pinLayout(shares, trackPx, lanes).map((p) => p.lane)
}

/** The layer slot nearest a point on the track: a mark always lands on a layer, never between two. */
export function layerAtPoint(clientX: number, track: { left: number; width: number }, n: number): number {
  if (n <= 1) return 1
  const span = Math.max(1, track.width - 2 * THUMB_R)
  const share = Math.max(0, Math.min(1, (clientX - track.left - THUMB_R) / span))
  return Math.round(share * (n - 1)) + 1
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

/** The loaded slots' colors, as one string so the selector stays stable. */
const useSlotColors = (): string[] => useApp((s) => resolveSlots(s).map((r) => r.color).join()).split(',').filter(Boolean)

/** Layer number (1-based) a mark sits on: the first layer whose top reaches its height. */
export function layerOf(m: Pick<LayerMark, 'z'>, layerZ: ArrayLike<number>): number {
  for (let i = 0; i < layerZ.length; i++) if ((layerZ[i] ?? 0) >= m.z - 1e-6) return i + 1
  return layerZ.length
}

/** Where the marks menu is open: under its + button, at a right-click point, or shut. */
export type MarksMenu = 'button' | { x: number; y: number } | null

/** The pause, color change and custom G-code pins over the layer slider; `x` is a layer's share along it. A click or right-click passes the pin's top left, where its menu opens. */
function LayerPins({ x, layerZ, track, onPick }: { x: (layer: number) => number; layerZ: ArrayLike<number>; track: RefObject<HTMLElement | null>; onPick: (layer: number, at: { x: number; y: number }) => void }) {
  const plateId = useApp((s) => s.activePlate)
  const marks = useApp((s) => s.layerMarks[plateId]) ?? EMPTY
  const colors = useSlotColors()
  const layers = marks.map((m) => layerOf(m, layerZ))
  const pins = pinLayout(layers.map((l) => x(l)), useSpan(track))
  const pick = (e: MouseEvent<HTMLButtonElement>, layer: number) => {
    e.preventDefault()
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    onPick(layer, { x: r.left, y: r.top - 4 })
  }
  return (
    <>
      {marks.map((m, i) => {
        const layer = layers[i]!
        const color = m.kind === 'color_change' && m.slot ? colors[m.slot - 1] : undefined
        const body = m.kind === 'custom' ? (m.gcode ?? '').split('\n')[0]!.slice(0, 60) : color ? `To slot ${m.slot}. Click to change or remove it.` : m.kind === 'color_change' && colors.length > 1 ? 'Click to pick its filament or remove it.' : 'Click to remove it.'
        return (
          <button
            key={m.id}
            type="button"
            className="layer-mark"
            data-kind={m.kind}
            data-lane={pins[i]!.lane}
            data-swatch={color ? '' : undefined}
            // the tip opens above the pin, so it never covers the Moves track under it
            data-tip-side="top"
            style={{ left: pins[i]!.off ? `calc(${x(layer) * 100}% + ${pins[i]!.off}px)` : `${x(layer) * 100}%`, ...(pins[i]!.lane ? ({ '--lane': pins[i]!.lane } as CSSProperties) : {}), ...(pins[i]!.off ? ({ '--off': `${pins[i]!.off}px`, '--jog': `${pins[i]!.elbow}px` } as CSSProperties) : {}), ...(color ? ({ '--c': color } as CSSProperties) : {}) }}
            aria-label={`Layer ${layer}, ${MARK_LABEL[m.kind]}`}
            {...tipAttrs({ title: `Layer ${layer}, ${MARK_LABEL[m.kind]}`, body })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => pick(e, layer)}
            onContextMenu={(e) => pick(e, layer)}
          >
            {color ? null : <Icon name={ICON[m.kind]} size={12} />}
            {/* the foot of the stem: down to the track, stepping back left to the layer when the head sits right of it */}
            <span className="layer-mark-leg" aria-hidden="true" />
          </button>
        )
      })}
    </>
  )
}

/** The + button beside the layer slider, its menu, and the custom G-code dialog, for the top layer. */
function LayerMarksMenu({ top, layerZ, menu, setMenu }: { top: number; layerZ: ArrayLike<number>; menu: MarksMenu; setMenu: (m: MarksMenu) => void }) {
  const plateId = useApp((s) => s.activePlate)
  const marks = useApp((s) => s.layerMarks[plateId]) ?? EMPTY
  const [custom, setCustom] = useState<{ text: string; z: number } | null>(null)
  // "Add color change" with more than one slot first asks which filament it changes to.
  const [picking, setPicking] = useState(false)
  const colors = useSlotColors()
  const z = layerZ[top - 1] ?? 0
  const here = marks.find((m) => Math.abs(m.z - z) < 1e-6)
  const close = () => (setMenu(null), setPicking(false))
  const add = (kind: MarkKind, slot?: number) => {
    if (kind === 'color_change' && slot === undefined && colors.length > 1) return setPicking(true)
    close()
    if (kind === 'custom') return setCustom({ text: '', z })
    addMark(z, kind, undefined, undefined, slot)
    toast(`${MARK_LABEL[kind]} added at layer ${top}${slot ? `, to slot ${slot}` : ''}. Slice again to put it in the file.`, 'info')
  }
  const fresh = nextSlot(z, marks, colors.length)
  const slotItems = (current: number | undefined, pick: (slot: number) => void) =>
    colors.map((c, i) => (
      <MenuItem key={i} checked={current === i + 1} aside={!here && i + 1 === fresh ? 'next' : undefined} onClick={() => pick(i + 1)}>
        <Swatch color={c} size="sm" /> Slot {i + 1}
      </MenuItem>
    ))
  const problem = custom ? customGcodeProblem(custom.text) : null
  return (
    <div className="lmarks-add">
      <MenuAnchor>
        <Button variant="ghost" size="sm" icon="plus" aria-haspopup="menu" aria-expanded={menu !== null} aria-label="Add layer action" tip={{ title: 'Add layer action', body: 'Pause, change the filament or insert G-code at the top layer.', key: 'Right-click' }} onClick={() => (menu ? close() : setMenu('button'))} />
        <Menu key={picking ? 'pick' : 'main'} open={menu !== null} onClose={close} label={picking ? `Color change at layer ${top}` : `Layer ${top} actions`} align="end" at={menu && menu !== 'button' ? menu : undefined}>
          {picking ? (
            <>
              <MenuHeading>Change to</MenuHeading>
              {slotItems(fresh, (slot) => add('color_change', slot))}
            </>
          ) : here ? (
            <>
              {here.kind === 'color_change' && colors.length > 1 ? (
                <>
                  <MenuHeading>Change to</MenuHeading>
                  {slotItems(here.slot, (slot) => (setMarkSlot(here.id, slot), close()))}
                  <MenuSeparator />
                </>
              ) : null}
              {here.kind === 'custom' ? (
                <MenuItem icon="rename" onClick={() => { close(); setCustom({ text: here.gcode ?? '', z }) }}>
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
          <MenuItem disabled>Layer {top}, {z.toFixed(2)} mm</MenuItem>
        </Menu>
      </MenuAnchor>
      <Dialog
        open={custom !== null}
        onClose={() => setCustom(null)}
        title={`Custom G-code at layer ${top}`}
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

/**
 * The layer slider in the playback bar, its pins over it, and the + for the top layer. A pin click and a right-click
 * go through `onJump`, the same layer step a typed layer takes, then open the marks menu for that layer.
 */
export function LayerTrack({ id, n, top, layerZ, onChange, onJump, onKeyDown }: { id: string; n: number; top: number; layerZ: ArrayLike<number>; onChange: (layer: number) => void; onJump: (layer: number) => void; onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void }) {
  const [menu, setMenu] = useState<MarksMenu>(null)
  const rail = useRef<HTMLDivElement>(null)
  const z = layerZ[top - 1] ?? 0
  const share = (layer: number) => (n > 1 ? (layer - 1) / (n - 1) : 0)
  return (
    <div
      className="layer-track"
      onContextMenu={(e) => {
        e.preventDefault()
        // over the track, the layer under the pointer; beside it (the +), the top layer
        const r = rail.current?.getBoundingClientRect()
        if (r && e.clientX >= r.left && e.clientX <= r.right) onJump(layerAtPoint(e.clientX, r, n))
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div className="layer-track-rail" ref={rail}>
        <Range id={id} className="thin" min={1} max={n} value={top} onChange={onChange} onKeyDown={onKeyDown} aria-valuetext={`Layer ${top} of ${n}, ${z.toFixed(2)} mm`} />
        <div className="layer-marks" data-testid="layer-pins">
          <TrackStrikes share={(layer: number) => share(layer) * 100} />
          <LayerPins x={share} layerZ={layerZ} track={rail} onPick={(layer, at) => (onJump(layer), setMenu(at))} />
        </div>
      </div>
      <LayerMarksMenu top={top} layerZ={layerZ} menu={menu} setMenu={setMenu} />
    </div>
  )
}
