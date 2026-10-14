// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The controls of the settings rows for text settings and for speeds or accelerations that are either a number or a
// percent of another setting (expert-settings.tsx puts them in a row). A value is stored the way the engine and the
// project file read it: text as a string, a number-or-percent as a list of one string, "40" or "40%".
import type { SettingDef, SettingValue } from '@slicerx/contracts'
import { Seg } from '@slicerx/ui'
import { isWideText, textOk } from '../../lib/setting-text'

export { isWideText, textOk }

/** The string a number-or-percent setting holds, read from its stored value ("50%", ["50%"], 50 or [50]). */
function stored(value: SettingValue | undefined): string {
  const x = Array.isArray(value) ? value[0] : value
  return x === undefined || x === null ? '' : String(x).trim()
}

/** A number-or-percent value split into its number and its unit. */
export function splitMmOrPercent(value: SettingValue | undefined): { num: string; percent: boolean } {
  const text = stored(value)
  return text.endsWith('%') ? { num: text.slice(0, -1).trim(), percent: true } : { num: text, percent: false }
}

/**
 * What a person typed into a number-or-percent field, as the value to store, or undefined when it is not a number.
 * A trailing % picks percent; otherwise the unit shown beside the field applies. The number keeps to the setting's
 * limits, as the other number fields do.
 */
export function parseMmOrPercent(def: Pick<SettingDef, 'min' | 'max' | 'orcaMin' | 'orcaMax'>, raw: string, percent: boolean): SettingValue | undefined {
  let text = raw.trim()
  let pct = percent
  if (text.endsWith('%')) {
    pct = true
    text = text.slice(0, -1).trim()
  }
  const n = Number(text)
  if (text === '' || !Number.isFinite(n)) return undefined
  const lo = def.orcaMin ?? def.min ?? -Infinity
  const hi = def.orcaMax ?? def.max ?? Infinity
  const v = Math.min(hi, Math.max(lo, n))
  return [`${String(v)}${pct ? '%' : ''}`]
}

/** Selects the field's text on the click that focuses it, as the number fields do. */
const selectOnFocus = {
  onFocus: (e: { currentTarget: HTMLInputElement }) => e.currentTarget.select(),
  onMouseDown: (e: { currentTarget: HTMLInputElement }) => {
    if (document.activeElement !== e.currentTarget) e.currentTarget.dataset['sel'] = '1'
  },
  onMouseUp: (e: { currentTarget: HTMLInputElement; preventDefault(): void }) => {
    if (e.currentTarget.dataset['sel'] === '1') e.preventDefault()
    delete e.currentTarget.dataset['sel']
  },
}

/** A text setting: committed on Enter or when the field loses focus; a value the setting cannot hold goes back. */
export function TextSetting({ id, def, value, mixed, disabled, onSet }: { id: string; def: SettingDef; value: SettingValue | undefined; mixed?: boolean; disabled?: boolean; onSet: (value: SettingValue) => void }) {
  const shown = mixed ? '' : stored(value)
  const wide = isWideText(def)
  return (
    <input
      id={id}
      key={shown}
      type="text"
      className={wide ? 'mini text wide' : 'mini text'}
      data-testid="setting-text"
      spellCheck={false}
      autoComplete="off"
      placeholder={mixed ? 'Mixed' : wide ? 'Not set' : undefined}
      disabled={disabled}
      defaultValue={shown}
      onBlur={(e) => {
        const next = e.currentTarget.value.trim()
        if (next === shown) return
        if (textOk(def.key, next)) onSet(next)
        else e.currentTarget.value = shown
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.currentTarget.value = shown
          e.currentTarget.blur()
        }
      }}
      {...selectOnFocus}
    />
  )
}

/**
 * A setting that is a number or a percent of another setting (small perimeter speed: mm/s, or a percent of the outer
 * wall speed): the unit toggle on the left, the number field at the column's edge like every other number. Switching
 * the unit keeps the number and stores it in the new unit.
 */
export function MmOrPercentSetting({ id, def, unit, value, mixed, disabled, onSet }: { id: string; def: SettingDef; unit: string; value: SettingValue | undefined; mixed?: boolean; disabled?: boolean; onSet: (value: SettingValue) => void }) {
  const { num, percent } = splitMmOrPercent(value)
  const shown = mixed ? '' : num
  const units = [
    { value: 'abs', label: unit, title: `In ${unit}` },
    { value: 'pct', label: '%', title: 'In percent' },
  ]
  return (
    <span className="mm-or-pct" data-testid="setting-mm-or-percent">
      <Seg
        label={`${def.label ?? def.key} unit`}
        size="sm"
        className="unit-seg"
        value={mixed ? '' : percent ? 'pct' : 'abs'}
        options={disabled ? units.map((u) => ({ ...u, disabled: true })) : units}
        onChange={(u) => {
          const next = parseMmOrPercent(def, num === '' ? '0' : num, u === 'pct')
          if (next !== undefined) onSet(next)
        }}
      />
      <input
        id={id}
        key={`${shown}${percent ? '%' : ''}`}
        className="mini num"
        inputMode="decimal"
        placeholder={mixed ? 'Mixed' : undefined}
        disabled={disabled}
        defaultValue={shown}
        onBlur={(e) => {
          if (e.currentTarget.value === shown) return
          const next = parseMmOrPercent(def, e.currentTarget.value, percent)
          if (next !== undefined) onSet(next)
          else e.currentTarget.value = shown
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        {...selectOnFocus}
      />
    </span>
  )
}
