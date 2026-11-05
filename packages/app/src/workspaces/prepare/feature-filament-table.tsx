// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Color tab's feature filament table (plate/feature-filaments.ts): one row per feature, each with a menu of the
// filament slots and the object's own filament. It edits the scope the pill above Print settings picks, the plate or
// the selection, reads "Mixed" across a selection that differs, and marks the values the selection set itself. After
// a slice that still matches the plate, each row also shows what the feature printed with. The filament menu ends at
// the rows' right edge like every settings control, so the printed-with swatches appearing never move it.
import type { SettingValue } from '@slicerx/contracts'
import { Icon, Menu, MenuAnchor, MenuItem, SettingRow, SwatchRing, tipAttrs } from '@slicerx/ui'
import { useMemo, useState, type ReactNode } from 'react'
import { slotLabel } from '../../filament/rail'
import type { ResolvedSlot } from '../../filament/slots'
import { useResolvedSlots } from '../../filament/use-slots'
import { featureFilamentRows, OBJECTS_FILAMENT, setFeatureFilament, type FeatureFilamentRow } from '../../plate/feature-filaments'
import type { SettingsScope } from '../../plate/scope'
import { get, useApp } from '../../state/store'
import './feature-filament-table.css'

/** A slot's short name for the closed menu: its label and type ("2 PLA"). */
function slotFace(slots: readonly ResolvedSlot[], n: number): string {
  const s = slots[n - 1]
  return s ? `${s.label} ${s.type}`.trim() : `${n}, not set up`
}

function Swatch({ slots, n, size = 14 }: { slots: readonly ResolvedSlot[]; n: number; size?: number }) {
  return <SwatchRing color={slots[n - 1]?.color ?? ''} size={size} className="ff-swatch" />
}

/** The swatches of what a feature printed with, or "None" for a feature the slice did not print. */
function Printed({ slots, row }: { slots: readonly ResolvedSlot[]; row: FeatureFilamentRow }) {
  if (!row.printedWith) return null
  const names = row.printedWith.map((n) => slots[n - 1] ? slotLabel(slots[n - 1]!) : String(n))
  const text = row.printedWith.length ? `${row.label} printed with ${names.join(' and ')}` : `No ${row.label.toLowerCase()} in this slice`
  return (
    <span className="ff-printed" data-testid="slice-feature-filament-printed" data-slots={row.printedWith.join(',')} role="img" aria-label={text} {...tipAttrs({ title: 'Printed with', body: text })}>
      {row.printedWith.length ? row.printedWith.map((n) => <Swatch key={n} slots={slots} n={n} size={12} />) : <span className="ff-none">None</span>}
    </span>
  )
}

function Pick({ row, slots, scope }: { row: FeatureFilamentRow; slots: readonly ResolvedSlot[]; scope: SettingsScope }) {
  const [open, setOpen] = useState(false)
  const count = Math.max(slots.length, row.value ?? 0, row.plateValue)
  const choose = (v: number) => {
    setFeatureFilament(get(), scope, row.key, v)
    setOpen(false)
  }
  const face = row.value === undefined ? 'Mixed' : row.value === 0 ? OBJECTS_FILAMENT : slotFace(slots, row.value)
  return (
    <MenuAnchor className="ff-anchor">
      <span className="sx-selectwrap">
        <button
          type="button"
          id={`set-${row.key}`}
          className="sx-select ff-face"
          data-size="sm"
          data-testid="slice-feature-filament-pick"
          data-key={row.key}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${row.label} filament: ${face}`}
          onClick={() => setOpen((o) => !o)}
        >
          {row.value ? <Swatch slots={slots} n={row.value} /> : null}
          <span>{face}</span>
        </button>
      </span>
      <Menu open={open} onClose={() => setOpen(false)} label={`${row.label} filament`} align="end" testId="slice-feature-filament-menu" target={row.key}>
        <MenuItem checked={row.value === 0} data-testid="slice-feature-filament-option" data-value={0} onClick={() => choose(0)}>
          {OBJECTS_FILAMENT}
        </MenuItem>
        {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
          <MenuItem key={n} checked={row.value === n} iconNode={<Swatch slots={slots} n={n} />} aside={row.value === n ? <Icon name="check" /> : undefined} data-testid="slice-feature-filament-option" data-value={n} onClick={() => choose(n)}>
            {slots[n - 1] ? slotLabel(slots[n - 1]!) : `${n}, not set up`}
          </MenuItem>
        ))}
      </Menu>
    </MenuAnchor>
  )
}

/** The table, for the plate or the scope's objects. `config` is the plate's resolved configuration. */
export function FeatureFilamentTable({ scope, config, chips }: { scope: SettingsScope; config: Readonly<Record<string, SettingValue>>; /** In the plate scope: the objects that print a row with their own filament, as chips under it. */ chips?: (key: string) => ReactNode }) {
  const slots = useResolvedSlots()
  const plate = useApp((s) => s.plate)
  const objectSettings = useApp((s) => s.objectSettings)
  const overrides = useApp((s) => s.overrides)
  const slice = useApp((s) => s.slice)
  const rows = useMemo(() => featureFilamentRows({ plate, objectSettings, overrides, slice }, config, scope), [plate, objectSettings, overrides, slice, config, scope])
  const scoped = scope.kind !== 'plate'
  const current = rows.some((r) => r.printedWith !== null)
  return (
    <ul className="ff-table" data-testid="slice-feature-filaments" data-scope={scope.kind} aria-label="Filament for each feature">
      <li className="sx-setrow ff-head" aria-hidden="true">
        <span />
        <span className="ff-label">
          <span>Feature</span>
          {current ? <span>Printed with</span> : null}
        </span>
        <span className="ff-head-pick">Filament</span>
        <span />
      </li>
      {rows.map((row) => (
        <SettingRow
          key={row.key}
          as="li"
          className={['field', 'ff-row', row.changed ? 'changed' : '', scoped && row.source === 'plate' ? 'inherited' : ''].filter(Boolean).join(' ')}
          data-testid="slice-feature-filament-row"
          data-feature={row.feature}
          data-key={row.key}
          data-source={row.source}
          data-value={row.value ?? ''}
          mark={
            row.changed ? (
              <span className="sx-setrow-dot" role="img" aria-label={scoped ? 'Set by the selection' : 'Changed'} {...tipAttrs({ title: scoped ? 'Its own' : 'Changed', body: scoped ? "The selection set this itself, over the plate's value." : 'Differs from the Easy value.' })} />
            ) : null
          }
          label={
            <span className="ff-label">
              <label className="ff-name" htmlFor={`set-${row.key}`}>
                {row.label}
                {scoped && row.source === 'mixed' ? <span className="scope-from">differs across the selection</span> : null}
              </label>
              <Printed slots={slots} row={row} />
            </span>
          }
          control={<Pick row={row} slots={slots} scope={scope} />}
          reset={
            row.changed ? (
              <button type="button" className="reset" data-testid="slice-feature-filament-row-reset" data-key={row.key} aria-label={`Reset ${row.label.toLowerCase()} filament`} {...tipAttrs({ title: 'Reset', body: scoped ? "Go back to the plate's value." : 'Go back to the Easy value.' })} onClick={() => setFeatureFilament(get(), scope, row.key, undefined)}>
                <Icon name="rotate" />
              </button>
            ) : null
          }
        >
          {(() => {
            const c = scoped ? null : chips?.(row.key)
            return c ? <p className="obj-chips">{c}</p> : null
          })()}
        </SettingRow>
      ))}
    </ul>
  )
}

/** The section's summary line: the features set to a slot or mixed across the selection, or the object's filament throughout. */
export function featureFilamentSummary(rows: readonly FeatureFilamentRow[], slots: readonly ResolvedSlot[]): string {
  const set = rows.filter((r) => r.value !== 0)
  if (!set.length) return OBJECTS_FILAMENT
  return set.slice(0, 3).map((r) => `${r.label.toLowerCase()} ${r.value === undefined ? 'mixed' : slotFace(slots, r.value)}`).join(', ')
}
