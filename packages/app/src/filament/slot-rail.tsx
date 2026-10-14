// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Filament section's spools: every slot the printer has loaded (or the project holds), grouped by the unit that
// holds it. A spool in use has an inset accent edge and a count of its parts, so picking one never changes its size. A
// click moves the target there: the selected objects, or with nothing selected the plate, or with two or more
// filaments in use the one picked in the row under the spools. Editing what a slot holds is in its menu (right-click,
// Shift+F10); Alt-click selects the objects on it. Hovering or focusing a spool picks its filament out in the viewport.
// Under the spools: what the target prints with, and why (picked by hand, by color, the spool used last), or that
// it is another material than the profile's. Every line keeps its height, so nothing moves when one changes.
import { Button, LinkButton, Menu, MenuItem, Seg, Select, SwatchRing, tipAttrs } from '@slicerx/ui'
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { activeMeta } from '../plate/plates'
import { selectByFilament } from '../plate/selection'
import { get, set, shownSlice, toast, useApp } from '../state/store'
import { colorName, railGroups, slotMismatch, slotUsage, type SlotMismatch } from './rail'
import { currentTarget, moveToSpool, profileMaterial, spoolParts, spoolPicks, targetSlot, type PickWhy, type SpoolTarget } from './pick'
import { SetupNoteLine, useSetupNotes } from './setup-plan'
import { MAX_SLOTS, resetSlots, setSlot, type ResolvedSlot } from './slots'
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
  /** The Tune, Retune or Tuned badge of the slot the line under the spools names, or null. */
  badge?: (s: ResolvedSlot) => ReactNode
  /** Shown at the right of the first unit's header in place of its count (Add filament). */
  add?: ReactNode
}

/** The target in words: "Cube", "3 objects", "the plate", or the parts on one filament. */
export function targetWords(target: SpoolTarget, plate: readonly { id: string; name: string }[], names: (slot: number) => string[]): string {
  if (target.kind === 'plate') return 'the plate'
  if (target.kind === 'filament') {
    const n = names(target.from)
    return n.length === 1 ? n[0]! : `${n.length} parts`
  }
  if (target.part) return target.part
  const picked = plate.filter((e) => target.ids.includes(e.id))
  return picked.length === 1 ? picked[0]!.name : `${picked.length} objects`
}

/**
 * The line under the spools: that a spool in use holds another material than the profile's (the target's first), else
 * why the target prints on its spool, else what a click does.
 */
export function pickNote(o: { spool: Pick<ResolvedSlot, 'label' | 'type'> | undefined; material: string; why: PickWhy | undefined; what: string; inUse?: readonly { type: string; what: string }[] }): { text: string; other: boolean } {
  const s = o.spool
  const differs = (type: string) => type.toUpperCase() !== o.material.toUpperCase()
  const other = s && differs(s.type) ? { type: s.type, what: o.what } : o.inUse?.find((x) => differs(x.type))
  if (other) return { text: `${other.type} on a ${o.material} profile: the slice uses ${other.type} settings for ${other.what}.`, other: true }
  const click = { text: o.what ? `Click a spool to print ${o.what} with it.` : '', other: false }
  if (!s) return click
  if (o.why === 'manual') return { text: `You picked ${s.label}.`, other: false }
  if (o.why === 'color') return { text: `Picked automatically: the closest ${o.material} to the model's color.`, other: false }
  if (o.why === 'last') return { text: 'Picked automatically: no color in the file, so the spool used last on this printer.', other: false }
  if (o.why === 'material') return { text: `Picked automatically: the first ${o.material} spool loaded.`, other: false }
  return click
}

export function SlotRail({ slots, left, badge, add }: SlotRailProps) {
  const hover = useApp((s) => s.hoverSlot)
  const printerSlots = useApp((s) => s.printerSlots)
  const plate = useApp((s) => s.plate)
  const plates = useApp((s) => s.plates)
  const activePlate = useApp((s) => s.activePlate)
  const selection = useApp((s) => s.selection)
  const selectedIds = useApp((s) => s.selectedIds)
  const material = profileMaterial({ profile: useApp((s) => s.profile) })
  const picks = useStore(spoolPicks, (s) => s.why)
  // The last slice's usage stays while a new one runs; stale arcs draw at half strength.
  const slice = shownSlice(useApp((s) => s.slice))
  const stale = slice?.stale === true
  const usage = slotUsage(slice?.result.stats, Math.max(...slots.map((s) => s.index), 0))
  const mismatches = new Map(slotMismatch(printerSlots, slots).map((m) => [m.slot, m]))
  const groups = railGroups(slots)
  const fromPrinter = printerSlots.length > 0
  const [menu, setMenu] = useState<{ slot: number; at: { x: number; y: number } } | null>(null)
  // With two or more filaments in use and nothing selected, the row under the spools picks which one moves.
  const [from, setFrom] = useState<number | null>(null)
  const parts = spoolParts(plate, activeMeta({ plates, activePlate }))
  const target = currentTarget({ selection, selectedIds, plate, plates, activePlate }, from)
  const on = targetSlot({ plate, plates, activePlate }, target)
  const names = (slot: number) => parts.get(slot)?.names ?? []
  const what = targetWords(target, plate, names)
  const bySlot = (n: number | null) => (n === null ? undefined : slots.find((s) => s.index === n))
  // The line names the hovered or focused spool, else the one the target prints with, else the first in use.
  const lineSlot = bySlot(hover) ?? bySlot(on) ?? slots.find((s) => parts.has(s.index)) ?? slots[0]
  const lineMismatch = lineSlot ? mismatches.get(lineSlot.index) : undefined
  const grams = (s: ResolvedSlot) => usage[s.index - 1]?.grams ?? null
  const firstId = target.kind === 'objects' ? target.ids[0] : plate.find((e) => target.kind === 'plate' || targetSlot({ plate: [e], plates, activePlate }, target) !== null)?.id
  const inUseWords = [...parts.entries()].flatMap(([n, p]) => {
    const sp = bySlot(n)
    return sp ? [{ type: sp.type, what: p.names.length === 1 ? p.names[0]! : `${p.parts} parts` }] : []
  })
  const note = pickNote({ spool: bySlot(on), material, why: firstId ? picks[firstId] : undefined, what: plate.length ? what : '', inUse: inUseWords })

  // A tray the printer reports with nothing in it, and nothing set for it here.
  const empty = (s: ResolvedSlot) => s.source !== 'user' && Boolean(printerSlots[s.index - 1]) && !printerSlots[s.index - 1]!.material && !printerSlots[s.index - 1]!.color
  const onClick = (e: MouseEvent<HTMLButtonElement>, s: ResolvedSlot) => {
    if (e.altKey) return selectSlotObjects(s.index, slotWords(s))
    // Nothing to move yet, or an empty tray: the click opens what the slot holds instead.
    if (plate.length === 0 || empty(s)) return set({ slotDialog: s.index })
    moveToSpool(target, s.index)
    if (target.kind === 'filament') setFrom(s.index)
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
  const inUse = [...parts.keys()].sort((a, b) => a - b)

  return (
    <div className="slot-rail-wrap" data-stale={stale ? true : undefined}>
      <div className="slot-rail" role="group" aria-label="Filament spools" data-testid="slice-filament-rail" onPointerLeave={() => set({ hoverSlot: null })}>
        {groups.map((g, gi) => (
          <div className="slot-rail-group" key={g.unit} role="group" aria-label={g.unit === 'Slots' ? 'Filaments' : g.unit}>
            <div className="slot-rail-unit" data-add={add && gi === 0 ? true : undefined}>
              <span>{g.unit === 'Slots' ? (fromPrinter ? 'Printer' : 'Filaments') : g.unit}</span>
              {add && gi === 0 ? add : <span>{fromPrinter ? `${g.slots.filter((s) => !empty(s)).length} loaded` : g.slots.length === 1 ? '1 filament' : `${g.slots.length} filaments`}</span>}
            </div>
            <div className="spool-grid">
              {g.slots.map((s) => {
                const m = mismatches.get(s.index)
                const share = usage[s.index - 1]?.share
                const n = parts.get(s.index)?.parts ?? 0
                const pct = s.remainingPct
                const lefts = left(s)
                const none = empty(s)
                return (
                  <button
                    key={s.index}
                    type="button"
                    className="spool"
                    aria-label={none ? `${s.label} empty` : `${s.label} ${slotWords(s)}${n ? `, ${n === 1 ? '1 part' : `${n} parts`}` : ''}`}
                    aria-pressed={on === s.index}
                    aria-describedby={m ? `slot-mm-${s.index}` : undefined}
                    data-testid="slice-filament-slot"
                    data-slot={s.index}
                    data-used={s.used ? 'true' : 'false'}
                    data-parts={n}
                    data-mismatch={m ? 'true' : undefined}
                    data-empty={none ? 'true' : undefined}
                    {...tipAttrs(none ? { title: `${s.label} is empty`, body: 'Load a spool on the printer, or click to set what this project prints with here.' } : { title: `${s.label} ${slotWords(s)}${lefts ? `, ${lefts}` : ''}`, body: m ? mismatchText(m) : `Click to print ${what} with it. Right-click to change what it holds.` })}
                    onPointerEnter={() => set({ hoverSlot: s.index })}
                    onFocus={() => set({ hoverSlot: s.index })}
                    onBlur={() => set({ hoverSlot: null })}
                    onClick={(e) => onClick(e, s)}
                    onContextMenu={(e) => onContext(e, s)}
                    onKeyDown={(e) => onKey(e, s)}
                  >
                    <span className="spool-count" aria-hidden="true">{n || ''}</span>
                    <SwatchRing color={none ? 'none' : s.color} size={30} {...(share !== undefined ? { usage: share } : {})} mismatch={Boolean(m)} selected={hover === s.index} />
                    <span className="spool-id">{s.label}</span>
                    <span className="spool-type">{none ? 'Empty' : s.type}</span>
                    {pct !== undefined ? (
                      <span className="spool-left" aria-hidden="true">
                        <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                      </span>
                    ) : null}
                    {m ? (
                      <span id={`slot-mm-${s.index}`} className="sr-only">
                        {mismatchText(m)}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="spool-target" data-testid="slice-filament-target" data-kind={target.kind}>
        {target.kind === 'filament' && inUse.length <= 3 ? (
          <Seg
            label="Filament to move"
            size="sm"
            full
            value={String(target.from)}
            onChange={(v) => setFrom(Number(v))}
            options={inUse.map((n) => ({ value: String(n), label: `Move ${names(n).length === 1 ? names(n)[0] : bySlot(n)?.label ?? n}`, tip: { title: `Parts on ${bySlot(n)?.label ?? n}`, body: names(n).join(', ') }, testId: `slice-filament-target-${n}` }))}
          />
        ) : target.kind === 'filament' ? (
          <label className="spool-target-pick">
            <span>Move the parts on</span>
            <Select id="spool-from" size="sm" aria-label="Filament to move" value={target.from} onChange={(e) => setFrom(Number(e.target.value))}>
              {inUse.map((n) => (
                <option key={n} value={n}>
                  {`${bySlot(n)?.label ?? n}: ${names(n).join(', ')}`}
                </option>
              ))}
            </Select>
          </label>
        ) : (
          <p className="spool-target-line">{plate.length === 0 ? 'Nothing on the plate yet.' : target.kind === 'plate' ? 'A click moves the whole plate.' : `A click moves the selection: ${what}.`}</p>
        )}
      </div>
      {lineSlot ? (
        <p className="slot-line" data-testid="slice-filament-slot-line" aria-live="polite">
          <span>{slotLine(lineSlot, grams(lineSlot), left(lineSlot))}</span>
          {/* Tune, Retune or Tuned for the slot the line names, so the spools stay one tight grid. */}
          {badge ? badge(lineSlot) : null}
          {lineMismatch ? (
            <button type="button" className="slot-line-fix" data-testid="slice-filament-use-printer" {...tipAttrs({ title: "Use printer's filament", body: mismatchText(lineMismatch) })} onClick={() => followPrinterSlot(lineMismatch.slot)}>
              Use printer's filament
            </button>
          ) : null}
        </p>
      ) : null}
      <p className="spool-note" data-testid="slice-filament-note" data-other={note.other ? 'true' : undefined} aria-live="polite" {...(note.text ? tipAttrs({ title: note.text }) : {})}>
        {note.text}
      </p>
      <Menu open={menu !== null} onClose={() => setMenu(null)} label="Filament slot" at={menu?.at}>
        <MenuItem icon="rename" data-testid="slice-filament-edit" onClick={() => menu && set({ slotDialog: menu.slot })}>
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

/** Four blank spools while the printer's slots load. */
export function SlotRailSkeleton() {
  return (
    <div className="slot-rail" aria-busy="true" aria-label="Loading the printer's filament">
      <div className="spool-grid">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="spool-skel" aria-hidden="true" />
        ))}
      </div>
    </div>
  )
}

/** No slot at all: a line and the button that adds the first one. */
export function SlotRailEmpty() {
  return (
    <div className="slot-rail-empty">
      <span>No filament yet.</span>
      <Button size="sm" icon="plus" data-testid="slice-filament-add" onClick={() => addSlot(1)}>
        Add filament
      </Button>
    </div>
  )
}

/** Adds filament `index` with the default material and color, and opens it so the person picks both. */
export function addSlot(index: number): void {
  if (index < 1 || index > MAX_SLOTS) return
  setSlot(index, {})
  set({ slotDialog: index })
}

/** The printer's filament unit in words, for the line under a rail it fills in. */
export function unitWords(system: 'ams' | 'mmu' | 'toolchanger' | undefined): string {
  if (system === 'mmu') return "the printer's MMU"
  if (system === 'toolchanger') return "the printer's tool heads"
  if (system === 'ams') return "the printer's AMS"
  return 'the printer'
}

export interface RailFootProps {
  /** The connected printer reports the slots (its AMS or MMU), so they follow what is loaded there. */
  fromPrinter: boolean
  system?: 'ams' | 'mmu' | 'toolchanger' | undefined
  /** Some slot is set here, over what the printer reports. */
  edited: boolean
}

/**
 * The last line of the section, kept to one line so Simple fits at 1440 x 900. With no printer filling the slots in:
 * how to change a filament (Add filament sits above the spools). With the printer's slots: where they come from and how to change one,
 * with the rest (for this project only, load a new filament on the printer) in its tip, and Reset to printer once a
 * slot was changed here. The spools above it never change height, so adding a filament never moves this line.
 */
export function RailFoot({ fromPrinter, system, edited }: RailFootProps) {
  const notes = useSetupNotes()
  if (fromPrinter) {
    const reset = edited ? (
      <LinkButton data-testid="slice-filament-foot-reset" onClick={() => resetSlots()}>
        Reset to printer
      </LinkButton>
    ) : null
    return (
      <div className="rail-foot" data-testid="slice-filament-foot" data-from="printer">
        {notes ? (
          <SetupNoteLine notes={notes} after={reset} />
        ) : (
          <p className="rail-foot-text" {...tipAttrs({ title: `Filled in from ${unitWords(system)}`, body: 'A change here is for this project only. To add a filament, load it on the printer.' })}>
            <span className="rail-foot-line">From {unitWords(system)}. Right-click a spool to change it.</span>
            {reset}
          </p>
        )}
      </div>
    )
  }
  return (
    <div className="rail-foot" data-testid="slice-filament-foot">
      {notes ? <SetupNoteLine notes={notes} /> : <p className="rail-foot-text"><span className="rail-foot-line">Right-click a filament to change it.</span></p>}
    </div>
  )
}

/** Add filament, at the top of the spools so the new one lands below it and nothing above it moves. */
export function AddFilament({ count }: { count: number }) {
  const full = count >= MAX_SLOTS
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="plus"
      data-testid="slice-filament-add"
      disabled={full}
      tip={{ title: 'Add filament', body: `Adds filament ${Math.min(count + 1, MAX_SLOTS)} and opens it to pick the material and color.`, ...(full ? { reason: `A project holds ${MAX_SLOTS} filaments at most.` } : {}) }}
      onClick={() => addSlot(count + 1)}
    >
      Add filament
    </Button>
  )
}
