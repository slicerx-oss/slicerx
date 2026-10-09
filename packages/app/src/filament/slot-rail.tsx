// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament rail: one ring per slot, grouped by the unit that holds it, with the share of the plate's filament as
// an arc from the last slice. Hovering or focusing a ring picks its filament out in the viewport; a click edits the
// slot, Alt-click selects every object on it. A slot set to something the printer does not hold carries a corner dot.
import { Menu, MenuItem, SwatchRing, tipAttrs } from '@slicerx/ui'
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { selectByFilament } from '../plate/selection'
import { get, set, shownSlice, toast, useApp } from '../state/store'
import { colorName, railGroups, slotMismatch, slotUsage, type SlotMismatch } from './rail'
import { setSlot, type ResolvedSlot } from './slots'
import './slot-rail.css'

/** A slot's filament in words: "PLA Matte Black", type, family when it has one, and the nearest plain color name. */
export function slotWords(s: Pick<ResolvedSlot, 'type' | 'family' | 'brand' | 'color'>): string {
  const family = s.family && s.family !== s.brand && !s.family.toLowerCase().includes(s.type.toLowerCase()) ? s.family : null
  return [s.type, family, colorName(s.color)].filter(Boolean).join(' ')
}

/** The line under the rail: "PLA Matte Black, 96 g, 62% left". */
export function slotLine(s: Pick<ResolvedSlot, 'type' | 'family' | 'brand' | 'color'>, grams: number | null, left: string | null): string {
  return [slotWords(s), grams !== null && grams > 0 ? `${Math.round(grams)} g` : null, left].filter(Boolean).join(', ')
}

/** Why a slot carries the mismatch dot: "The printer has PETG White in slot 2. The project uses PLA Black." */
export function mismatchText(m: SlotMismatch): string {
  return `The printer has ${m.printerType} ${colorName(m.printerColor)} in slot ${m.slot}. The project uses ${m.type} ${colorName(m.color)}.`
}

/** Selects every object printing with `slot` and says so: "Selected 3 objects on PLA Black". */
export function selectSlotObjects(slot: number, words: string): void {
  const ids = selectByFilament(get().plate, slot)
  if (!ids.length) return void toast(`Nothing on the plate uses ${words}`, 'info')
  set({ selection: ids[0]!, selectedIds: ids })
  toast(`Selected ${ids.length === 1 ? '1 object' : `${ids.length} objects`} on ${words}`, 'info')
}

/** Back to what the printer holds in the slot: its own setup is dropped, so the slot follows the printer again. */
export function followPrinterSlot(slot: number): void {
  set((s) => {
    const { [slot]: _drop, ...rest } = s.slotSetup
    return { slotSetup: rest }
  })
}

export interface SlotRailProps {
  slots: readonly ResolvedSlot[]
  /** What is left on a slot's spool, in words, or null. */
  left: (s: ResolvedSlot) => string | null
  /** The slot's Tune badge, or null. */
  badge?: (s: ResolvedSlot) => ReactNode
  /** Adds a slot (no printer reports slots): a plus ring at the end of the rail. */
  onAdd?: () => void
}

export function SlotRail({ slots, left, badge, onAdd }: SlotRailProps) {
  const hover = useApp((s) => s.hoverSlot)
  const printerSlots = useApp((s) => s.printerSlots)
  // The last slice's usage stays while a new one runs; stale arcs draw at half strength.
  const slice = shownSlice(useApp((s) => s.slice))
  const stale = slice?.stale === true
  const usage = slotUsage(slice?.result.stats, Math.max(...slots.map((s) => s.index), 0))
  const mismatches = new Map(slotMismatch(printerSlots, slots).map((m) => [m.slot, m]))
  const groups = railGroups(slots)
  const [menu, setMenu] = useState<{ slot: number; at: { x: number; y: number } } | null>(null)
  // The line names the hovered or focused slot, else the first one in use.
  const lineSlot = slots.find((s) => s.index === hover) ?? slots.find((s) => s.used) ?? slots[0]
  const lineMismatch = lineSlot ? mismatches.get(lineSlot.index) : undefined
  const grams = (s: ResolvedSlot) => usage[s.index - 1]?.grams ?? null

  const onClick = (e: MouseEvent<HTMLButtonElement>, s: ResolvedSlot) => {
    if (e.altKey) return selectSlotObjects(s.index, slotWords(s))
    set({ slotDialog: s.index })
  }
  const onContext = (e: MouseEvent<HTMLButtonElement>, s: ResolvedSlot) => {
    e.preventDefault()
    setMenu({ slot: s.index, at: { x: e.clientX, y: e.clientY } })
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, s: ResolvedSlot) => {
    // Shift+F10 or the context menu key open the slot's menu by keyboard.
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      setMenu({ slot: s.index, at: { x: r.left, y: r.bottom } })
    }
  }
  const menuSlot = menu ? slots.find((s) => s.index === menu.slot) : undefined

  return (
    <div className="slot-rail-wrap" data-stale={stale ? true : undefined}>
      <div className="slot-rail" role="group" aria-label="Filament slots" data-testid="slice-filament-rail" onPointerLeave={() => set({ hoverSlot: null })}>
        {groups.map((g) => (
          <div className="slot-rail-group" key={g.unit} role="group" aria-label={groups.length > 1 ? g.unit : undefined}>
            {groups.length > 1 ? <span className="slot-rail-unit">{g.unit}</span> : null}
            <div className="slot-rail-rings">
              {g.slots.map((s) => {
                const m = mismatches.get(s.index)
                const share = usage[s.index - 1]?.share
                return (
                  <div className={s.used ? 'slot' : 'slot unused'} data-slot={s.index} key={s.index}>
                    <button
                      type="button"
                      className="slot-ring"
                      aria-label={`Edit filament ${s.index}`}
                      aria-describedby={m ? `slot-mm-${s.index}` : undefined}
                      data-testid="slice-filament-slot"
                      data-slot={s.index}
                      data-used={s.used ? 'true' : 'false'}
                      data-mismatch={m ? 'true' : undefined}
                      {...tipAttrs({ title: `${s.label} ${slotWords(s)}`, body: m ? mismatchText(m) : 'Click to change it. Alt-click selects the objects that print with it.' })}
                      onPointerEnter={() => set({ hoverSlot: s.index })}
                      onFocus={() => set({ hoverSlot: s.index })}
                      onBlur={() => set({ hoverSlot: null })}
                      onClick={(e) => onClick(e, s)}
                      onContextMenu={(e) => onContext(e, s)}
                      onKeyDown={(e) => onKey(e, s)}
                    >
                      <SwatchRing color={s.color} label={s.label} {...(share !== undefined ? { usage: share } : {})} dim={!s.used} mismatch={Boolean(m)} selected={hover === s.index} />
                    </button>
                    {m ? (
                      <span id={`slot-mm-${s.index}`} className="sr-only">
                        {mismatchText(m)}
                      </span>
                    ) : null}
                    {badge ? badge(s) : null}
                  </div>
                )
              })}
              {onAdd ? (
                <button type="button" className="slot-ring slot-add" aria-label="Add filament" {...tipAttrs({ title: 'Add filament' })} onClick={onAdd}>
                  <span className="slot-add-disc" aria-hidden="true">+</span>
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {lineSlot ? (
        <p className="slot-line" data-testid="slice-filament-slot-line" aria-live="polite">
          <span>{slotLine(lineSlot, grams(lineSlot), left(lineSlot))}</span>
          {lineMismatch ? (
            <button type="button" className="slot-line-fix" data-testid="slice-filament-use-printer" {...tipAttrs({ title: "Use printer's filament", body: mismatchText(lineMismatch) })} onClick={() => followPrinterSlot(lineMismatch.slot)}>
              Use printer's filament
            </button>
          ) : null}
        </p>
      ) : null}
      <Menu open={menu !== null} onClose={() => setMenu(null)} label="Filament slot" at={menu?.at}>
        <MenuItem icon="rename" onClick={() => menu && set({ slotDialog: menu.slot })}>
          Edit filament
        </MenuItem>
        {menuSlot ? (
          <MenuItem icon="select-by-filament" onClick={() => selectSlotObjects(menuSlot.index, slotWords(menuSlot))}>
            Select objects on it
          </MenuItem>
        ) : null}
        {menu && mismatches.has(menu.slot) ? (
          <MenuItem icon="spool" data-testid="slice-filament-use-printer" onClick={() => followPrinterSlot(menu.slot)}>
            Use printer's filament
          </MenuItem>
        ) : null}
      </Menu>
    </div>
  )
}

/** Three rings while the printer's slots load. */
export function SlotRailSkeleton() {
  return (
    <div className="slot-rail" aria-busy="true" aria-label="Loading the printer's filament">
      <div className="slot-rail-rings">
        {[0, 1, 2].map((i) => (
          <span key={i} className="slot-skel" aria-hidden="true" />
        ))}
      </div>
    </div>
  )
}

/** No slot at all: a line and a plus ring that adds the first one. */
export function SlotRailEmpty() {
  return (
    <div className="slot-rail-empty">
      <button type="button" className="slot-ring slot-add" aria-label="Add filament" onClick={() => setSlot(1, {})}>
        <span className="slot-add-disc" aria-hidden="true">+</span>
      </button>
      <span>No filament yet. Add one.</span>
    </div>
  )
}
