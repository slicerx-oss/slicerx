// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate list: every plate with its object count, the add button, and per-plate settings (name,
// bed type, print sequence, filament order). Drawn as thumbnails along the bottom of the viewport,
// or as a sidebar block, per the look and feel.
import type { LayoutSpec } from '@slicerx/contracts'
import { Block, Button, Icon, Select, tipAttrs } from '@slicerx/ui'
import { useMemo, useState } from 'react'
import { resolveConfig } from '../../adapters/settings'
import { addPlate, duplicatePlate, removePlate, renamePlate, setPlateSettings, switchPlate } from '../../plate/plates'
import { useApp, type PlateEntry, type PlateMeta, type PlateSettings } from '../../state/store'
import { PlateThumb } from '../preview/plate-thumb'
import { plateSequence } from '../../plate/plate-sequence'
import { BED_TYPE_OPTIONS, type BedType } from '../../plate/bed-type'

const BED_TYPES: readonly { value: BedType | ''; label: string }[] = [{ value: '', label: 'Printer default' }, ...BED_TYPE_OPTIONS]

function usePlates(): { plates: PlateMeta[]; active: string; activeCount: number } {
  const plates = useApp((s) => s.plates)
  const active = useApp((s) => s.activePlate)
  const activeCount = useApp((s) => s.plate.length)
  return { plates, active, activeCount }
}

/** The Print sequence setting, which a plate without its own sequence follows. */
function useGlobalSequence(): 'by-layer' | 'by-object' {
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  return useMemo(() => plateSequence(undefined, resolveConfig(easy, overrides)), [easy, overrides])
}

const SEQUENCE_LABEL = { 'by-layer': 'By layer', 'by-object': 'By object' } as const

function PlateSettingsForm({ plate, slots, canDelete, onDone }: { plate: PlateMeta; slots: number; canDelete: boolean; onDone: () => void }) {
  const [name, setName] = useState(plate.name)
  const order = plate.settings.filamentOrder ?? Array.from({ length: slots }, (_, i) => i + 1)
  const move = (i: number, d: -1 | 1) => {
    const next = [...order]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    setPlateSettings(plate.id, { filamentOrder: next })
  }
  const id = plate.id
  const global = useGlobalSequence()
  return (
    <div className="plate-form" role="group" aria-label={`${plate.name} settings`}>
      <label className="plate-form-row" htmlFor={`pn-${id}`}>
        <span>Name</span>
        <input id={`pn-${id}`} className="sx-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={() => renamePlate(id, name)} onKeyDown={(e) => e.key === 'Enter' && renamePlate(id, name)} />
      </label>
      <label className="plate-form-row" htmlFor={`pb-${id}`}>
        <span>Bed type</span>
        <Select id={`pb-${id}`} size="sm" value={plate.settings.bedType ?? ''} onChange={(e) => {
          const v = e.target.value as PlateSettings['bedType'] | ''
          const { bedType: _drop, ...rest } = plate.settings
          setPlateSettings(id, v ? { ...rest, bedType: v } : rest, true)
        }}>
          {BED_TYPES.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="plate-form-row" htmlFor={`ps-${id}`} {...tipAttrs({ title: 'Print sequence', body: 'Same as print settings follows Print sequence in the print settings. By layer or By object sets this plate on its own.' })}>
        <span>Print sequence</span>
        <Select id={`ps-${id}`} size="sm" value={plate.settings.sequence ?? ''} onChange={(e) => {
          const v = e.target.value as PlateSettings['sequence'] | ''
          const { sequence: _drop, ...rest } = plate.settings
          setPlateSettings(id, v ? { ...rest, sequence: v } : rest, true)
        }}>
          <option value="">Same as print settings ({SEQUENCE_LABEL[global].toLowerCase()})</option>
          <option value="by-layer">By layer</option>
          <option value="by-object">By object</option>
        </Select>
      </label>
      {slots > 1 ? (
        <div className="plate-form-row plate-order">
          <span>Filament order</span>
          <ol aria-label="Filament order">
            {order.map((slot, i) => (
              <li key={slot}>
                <span className="sx-mono">Slot {slot}</span>
                <Button size="sm" variant="ghost" icon="chevron-up" aria-label={`Print slot ${slot} earlier`} disabled={i === 0} onClick={() => move(i, -1)} />
                <Button size="sm" variant="ghost" icon="chevron-down" aria-label={`Print slot ${slot} later`} disabled={i === order.length - 1} onClick={() => move(i, 1)} />
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <div className="plate-form-act">
        <Button size="sm" variant="ghost" icon="copy" onClick={() => { duplicatePlate(id); onDone() }}>
          Duplicate plate
        </Button>
        <Button size="sm" variant="ghost" icon="delete" onClick={() => removePlate(id)} disabled={!canDelete}>
          Delete plate
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

/** One slot count for the filament order: the most slots any object on the active plate uses, a filament picked in the object list included. */
export function slotsOnPlate(plate: readonly Pick<PlateEntry, 'parts' | 'slotOverrides'>[]): number {
  return plate.reduce((n, p) => Math.max(n, ...p.parts.map((x) => p.slotOverrides?.[x.name] ?? x.slot)), 1)
}

function useSlots(): number {
  return useApp((s) => slotsOnPlate(s.plate))
}

export function PlateList({ layout }: { layout: LayoutSpec }) {
  const { plates, active, activeCount } = usePlates()
  const activeObjects = useApp((s) => s.plate)
  const bed = useApp((s) => s.bed)
  const [editing, setEditing] = useState<string | null>(null)
  const slots = useSlots()
  const editingPlate = plates.find((p) => p.id === editing)
  const global = useGlobalSequence()
  // The SlicerX preset hides a lone plate; a second one shows the list.
  if (layout.plateList === 'hidden-single' && plates.length === 1 && !editing) {
    return (
      <div className="plate-strip single">
        <Button size="sm" variant="ghost" icon="new-plate" onClick={() => addPlate()} tip="plate.add">
          Add plate
        </Button>
        <Button size="sm" variant="ghost" icon="settings" aria-label="Plate settings" tip="plate.settings" onClick={() => setEditing(active)} />
      </div>
    )
  }
  const list = (
    <ul className="plate-cards" aria-label="Plates">
      {plates.map((p, i) => {
        const on = p.id === active
        const count = on ? activeCount : p.objects.length
        return (
          <li key={p.id}>
            <button type="button" className="plate-card" aria-current={on ? 'true' : undefined} onClick={() => switchPlate(p.id)} {...tipAttrs({ title: p.name, body: `${count} ${count === 1 ? 'object' : 'objects'} on this plate.` })}>
              <PlateThumb objects={on ? activeObjects : p.objects} bed={bed} size={30} />
              <span className="plate-no sx-mono">{i + 1}</span>
              <span className="plate-name">{p.name}</span>
              <span className="plate-count sx-mono">{count}</span>
              {(p.settings.sequence ?? global) === 'by-object' ? <Icon name="layers" size={12} label="By object" /> : null}
            </button>
            <Button size="sm" variant="ghost" icon="settings" aria-label={`${p.name} settings`} onClick={() => setEditing(editing === p.id ? null : p.id)} />
          </li>
        )
      })}
      <li>
        <Button size="sm" variant="ghost" icon="new-plate" onClick={() => addPlate()}>
          Add plate
        </Button>
      </li>
    </ul>
  )
  const form = editingPlate ? <PlateSettingsForm key={editingPlate.id} plate={editingPlate} slots={slots} canDelete={plates.length > 1} onDone={() => setEditing(null)} /> : null
  if (layout.plateList === 'sidebar') {
    return (
      <Block title="Plates" aside={`${plates.length}`} data-section="plates">
        {list}
        {form}
      </Block>
    )
  }
  return (
    <div className="plate-strip sx-overlay">
      {list}
      {form ? <div className="plate-strip-form">{form}</div> : null}
    </div>
  )
}
