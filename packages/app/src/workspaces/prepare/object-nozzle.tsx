// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The nozzle chip in an object's row, on a printer whose nozzles are not all one size: the object's nozzle in short
// ("0.6 R"), and a menu to print the object with another nozzle. The look of the chip, the menu and the choice when the
// object's filament also prints other objects is set in one place, NOZZLE_UI, so each can change without touching the
// rest. Nothing shows on printers with one nozzle size.
import { Icon, Menu, MenuHeading, MenuItem, tipAttrs } from '@slicerx/ui'
import { useMemo, useState } from 'react'
import { resolveConfig } from '../../adapters/config'
import { nozzleChipText, nozzleChoices, nozzleKind, objectNozzle, setObjectNozzle, type NozzleChoice, type NozzlePick } from '../../filament/object-nozzle'
import { toast, useApp, type PlateEntry } from '../../state/store'
import './object-nozzle.css'

/**
 * How the chip and its menu look. chip: `short` writes the size and side ("0.6 R"). menu: `nozzles` lists one item per
 * nozzle with the filament it prints there. split: `inline` offers moving the filament or a new one inside the menu.
 * paintWarning: `line` puts a plain line under Move filament naming the painted objects the move would print on two
 * nozzles; the person can still pick it.
 */
export const NOZZLE_UI = { chip: 'short', menu: 'nozzles', split: 'inline', paintWarning: 'line' } as const

/** The warning under Move filament: which painted objects it would print on two nozzles. */
export function paintWarningText(names: readonly string[]): string {
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  return `${list} ${names.length === 1 ? 'is' : 'are'} painted with this filament and another, so ${names.length === 1 ? 'its' : 'their'} paint would print on the other nozzle.`
}

/** The chip's text for the object's nozzle. */
function chipText(cfg: Record<string, unknown>, extruder: number, mm: number): string {
  return nozzleChipText(cfg, extruder, mm)
}

function run(objectId: string, extruder: number, pick: NozzlePick = {}): void {
  const r = setObjectNozzle(objectId, extruder, pick)
  if (!r.ok) toast(r.message, 'warn')
}

/** The menu items for one nozzle: one pick, or with a shared filament the two ways to move there. */
function NozzleItems({ entry, choice, close }: { entry: PlateEntry; choice: NozzleChoice; close: () => void }) {
  const go = (pick: NozzlePick = {}) => {
    close()
    run(entry.id, choice.extruder, pick)
  }
  const second = `filament ${choice.filament}`
  if (choice.current || choice.sharedWith.length === 0) {
    return (
      <MenuItem checked={choice.current} aside={second} data-testid="object-nozzle-item" data-extruder={choice.extruder} onClick={() => go()}>
        {choice.label}
      </MenuItem>
    )
  }
  const others = choice.sharedWith.join(', ')
  return (
    <span role="group" aria-label={choice.label} className="sx-menu-group">
      <MenuHeading>{choice.label}</MenuHeading>
      <MenuItem icon="nozzle" data-testid="object-nozzle-move" data-extruder={choice.extruder} {...(choice.paintSplit.length ? { 'aria-describedby': `nozzle-paint-${entry.id}-${choice.extruder}` } : {})} onClick={() => go({ moveFilament: true, confirmPainted: true })}>
        Move filament {choice.filament} ({others} {choice.sharedWith.length === 1 ? 'moves' : 'move'} too)
      </MenuItem>
      {NOZZLE_UI.paintWarning === 'line' && choice.paintSplit.length ? (
        <p className="obj-nozzle-warn" id={`nozzle-paint-${entry.id}-${choice.extruder}`} data-testid="object-nozzle-paint-warning">
          <Icon name="alert" size={12} />
          {paintWarningText(choice.paintSplit)}
        </p>
      ) : null}
      <MenuItem icon="plus" data-testid="object-nozzle-new" data-extruder={choice.extruder} onClick={() => go({ newFilament: true })}>
        Use a new filament for {entry.name}
      </MenuItem>
    </span>
  )
}

/** The chip and its menu, or nothing when the printer's nozzles are one size. */
export function ObjectNozzleChip({ entry }: { entry: PlateEntry }) {
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const cfg = useMemo(() => resolveConfig(easy, overrides) as Record<string, unknown>, [easy, overrides])
  // Read as text, so the row renders again only when the answer changes.
  const shown = useApp((s) => (nozzleKind(cfg) ? JSON.stringify([objectNozzle(s, entry, cfg), nozzleChoices(s, entry, cfg)]) : ''))
  const [now, choices] = useMemo(() => (shown ? (JSON.parse(shown) as [ReturnType<typeof objectNozzle>, NozzleChoice[]]) : [null, []]), [shown])
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  if (!now) return null
  const conflict = 'conflict' in now ? now.conflict : null
  const current = choices.find((c) => c.current)
  const text = conflict || !current ? '?' : chipText(cfg, current.extruder, current.mm)
  const title = conflict ? 'Nozzles of two sizes' : `Nozzle: ${current?.label ?? ''}`
  return (
    <>
      <button
        type="button"
        className="obj-nozzle"
        data-testid="object-nozzle"
        data-extruder={current?.extruder}
        data-conflict={conflict ? 'true' : undefined}
        aria-haspopup="menu"
        aria-label={conflict ?? `${title} for ${entry.name}`}
        {...tipAttrs({ title, body: conflict ?? 'Click to print it with another nozzle.' })}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        {conflict ? <Icon name="alert" size={12} /> : null}
        {text}
      </button>
      <Menu open={at !== null} onClose={() => setAt(null)} label={`Nozzle for ${entry.name}`} at={at ?? undefined} testId="object-nozzle-pick" target={entry.id}>
        <MenuHeading>Nozzle for {entry.name}</MenuHeading>
        {choices.map((c) => (
          <NozzleItems key={c.extruder} entry={entry} choice={c} close={() => setAt(null)} />
        ))}
      </Menu>
    </>
  )
}
