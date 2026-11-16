// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The send card's spool strip, as data: every slot the printer reports, in its units' order, each with what it holds.
// Nothing here invents a slot: a slot the printer does not report is not on the strip, and an empty one says so and
// can't be picked. A loaded spool of another material than the plate was sliced for can't be picked either.
import { baseMaterial, EXTERNAL_SLOT, type FilamentSlot, type PrinterLive } from '@slicerx/contracts'
import { colorName } from '../../filament/rail'
import { slotGroups } from '../../features/fleet/hud'
import { EXTERNAL_MARK, EXTERNAL_SPOOL, PICKED_SPOOL, SLOT_LABEL } from './send-words'

const isHex = (c: string | undefined): c is string => typeof c === 'string' && /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)
const hex6 = (c: string): string => (c.startsWith('#') ? c.slice(0, 7) : `#${c.slice(0, 6)}`)

export interface SpoolChip {
  /** The slot's id as the printer reports it ("A2", or "1" for the external spool). */
  id: string
  /** What the chip shows where an AMS slot shows its number. */
  mark: string
  material: string
  /** `#rrggbb`, or empty when the printer reports none. */
  color: string
  /** The color in plain words ("Blue"), or empty. */
  colorWord: string
  empty: boolean
  /** A loaded spool of another material than the plate's. */
  other: boolean
  /** The filament number this slot feeds, on a plate of two or more filaments. */
  feeds?: number
}

export interface SpoolUnit {
  /** "AMS lite", "AMS", "External spool". */
  label: string
  chips: SpoolChip[]
}

/**
 * The strip's units and chips from the printer's slots as it reports them. `material` is what the plate was sliced for
 * (null when not known, which leaves every loaded spool pickable). `feeds` is the send's slot per filament (1 based),
 * marked on its chips when the plate has two or more.
 */
export function spoolUnits(slots: readonly FilamentSlot[], live: PrinterLive | undefined, model: string, material: string | null, feeds: Readonly<Record<number, string>>): SpoolUnit[] {
  const many = Object.keys(feeds).length > 1
  return slotGroups(slots, live, model).map((g) => ({
    label: g.label,
    chips: g.slots.map((s): SpoolChip => {
      const empty = !s.material
      const color = isHex(s.color) ? hex6(s.color) : ''
      const feed = many ? Object.entries(feeds).find(([, id]) => id === s.id)?.[0] : undefined
      return {
        id: s.id,
        mark: s.id === EXTERNAL_SLOT ? EXTERNAL_MARK : s.id,
        material: s.material ?? '',
        color,
        colorWord: color ? colorName(color) : '',
        empty,
        other: !empty && material !== null && baseMaterial(s.material) !== baseMaterial(material),
        ...(feed !== undefined ? { feeds: Number(feed) } : {}),
      }
    }),
  }))
}

/** The strip header's printer part: the unit names, then the printer ("AMS lite / A1"). */
export function stripHead(units: readonly SpoolUnit[], printer: string): { units: string; printer: string } {
  return { units: units.map((u) => u.label).join(' + '), printer }
}

/** The slot as a person reads it: "Slot A4", or "External spool". */
export function slotLabel(id: string): string {
  return id === EXTERNAL_SLOT ? EXTERNAL_SPOOL : SLOT_LABEL(id)
}

/** A slot inside the header's "Slots A1, A2" list: the bare slot, or "External spool". */
export function slotInList(id: string): string {
  return id === EXTERNAL_SLOT ? EXTERNAL_SPOOL : id
}

/** The header line once a spool is picked: "White PETG · Slot A4". */
export function pickedLine(chip: Pick<SpoolChip, 'id' | 'material' | 'colorWord'>): string {
  return PICKED_SPOOL(chip.colorWord, chip.material, slotLabel(chip.id))
}
