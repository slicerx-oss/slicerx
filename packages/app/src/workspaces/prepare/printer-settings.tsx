// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer settings in Orca-style tabs: basic information, extruder and retraction, motion ability,
// multimaterial and cooling. It starts from the selected printer's profile and edits the changes the
// person keeps in a printer preset. Advanced and up only. Machine G-code is not editable here: text that
// runs on the printer waits for the G-code check (docs/safety.md). Network settings hold credentials and
// stay out.
import { resolveConfig } from '../../adapters/config'
import type { PrintConfig, SettingDef, SettingValue } from '@slicerx/contracts'
import { Button, Dialog, Icon, Seg } from '@slicerx/ui'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { SETTINGS } from '../../adapters/settings'
import { fuzzyScore } from '../../commands/fuzzy'
import { effectiveMode, useLayout } from '../../first-run/look'
import { markStale, openSettings, set, useApp } from '../../state/store'
import { EDITABLE, Field, LIST_ENUM_KEYS, visibleLevels } from './expert-settings'
import { printerBase } from './printer-base'
import { NozzlePicker } from './nozzle-picker'

const TABS: { id: string; label: string; groups: string[] }[] = [
  { id: 'basic', label: 'Basic information', groups: ['machine'] },
  { id: 'extruder', label: 'Extruder and retraction', groups: ['retraction'] },
  { id: 'motion', label: 'Motion ability', groups: ['motion'] },
  { id: 'multi', label: 'Multimaterial', groups: ['multimaterial'] },
  { id: 'cooling', label: 'Cooling', groups: ['cooling'] },
]

const PRINTER_KEYS = SETTINGS.filter((d) => d.section === 'printer' && (EDITABLE.has(d.type) || LIST_ENUM_KEYS.has(d.key)))

/** The Printer settings keys: numbers, switches and choices, plus the per-extruder choice lists named in LIST_ENUM_KEYS. */
export const printerKeys = (): readonly string[] => PRINTER_KEYS.map((d) => d.key)

const first = (v: SettingValue | undefined): unknown => (Array.isArray(v) ? v[0] : v)

/**
 * The lines under Z hop type: when the extruders hold different types, when the type has no effect (no lift height,
 * or the firmware retracts), and how a ramp is written for other apps. Two at most, so the hint stays short.
 */
export function zHopTypeNote(config: Record<string, SettingValue | undefined>): string | undefined {
  const types = config['z_hop_types']
  const lines: string[] = []
  if (Array.isArray(types) && types.some((t) => t !== types[0])) lines.push('The extruders use different types; choosing one sets both.')
  const fw = first(config['use_firmware_retraction'])
  if (fw === true || fw === 1 || fw === '1' || fw === 'true') lines.push('This printer retracts with its own firmware commands, so the type is not used.')
  else if (Number(first(config['z_hop']) ?? 0) <= 0) lines.push('Z hop height is 0, so the nozzle does not lift.')
  if (first(types) === 'Ramp Lift') lines.push('Ramp is written as Slope when you export for Bambu Studio or OrcaSlicer.')
  return lines.length ? lines.slice(0, 2).join(' ') : undefined
}

export function setPrinterSetting(key: string, value: SettingValue | undefined, base: PrintConfig | undefined): void {
  set((s) => {
    const next = { ...s.overrides }
    if (value === undefined) delete next[key]
    else {
      // Machine limits and the like hold one value per mode; a field edits the first and keeps the rest.
      const cur = (next[key] ?? (base as Record<string, SettingValue> | undefined)?.[key]) as SettingValue | undefined
      // Z hop type is one row for every extruder: the choice goes to each entry, and the list keeps its length.
      if (LIST_ENUM_KEYS.has(key) && Array.isArray(value)) next[key] = Array.from({ length: Array.isArray(cur) ? Math.max(1, cur.length) : 1 }, () => value[0]) as SettingValue
      else next[key] = Array.isArray(cur) && cur.length > 1 && Array.isArray(value) ? ([value[0], ...cur.slice(1)] as SettingValue) : value
    }
    return { overrides: next }
  })
  markStale()
}

export function PrinterSettingsDialog({ printer }: { printer: { vendor: string; model: string } | undefined }) {
  const open = useApp((s) => s.printerSettingsOpen)
  const overrides = useApp((s) => s.overrides)
  const layout = useLayout()
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const levels = useMemo(() => visibleLevels(mode, layout), [mode, layout])
  const [tab, setTab] = useState('basic')
  const [query, setQuery] = useState('')
  const focus = useApp((s) => s.settingFocus)
  useEffect(() => {
    if (!open || !focus || !PRINTER_KEYS.some((d) => d.key === focus.key)) return
    setQuery(focus.label)
    set({ settingFocus: null })
  }, [open, focus])
  const q = useDeferredValue(query.trim())
  const base = useMemo(() => printerBase(printer), [printer])
  const easy = useApp((s) => s.easy)
  const profile = useApp((s) => s.profile)
  // The values the slice uses: the printer's shipped presets under the person's changes.
  const config = useMemo(() => ({ ...base, ...resolveConfig(easy, overrides) }) as Record<string, SettingValue | undefined>, [base, easy, overrides, profile])
  const groups = TABS.find((t) => t.id === tab)?.groups ?? []
  // A changed key stays listed whatever the mode, so a change made in a higher mode is never hidden.
  const defs: SettingDef[] = useMemo(
    () =>
      PRINTER_KEYS.filter((d) => (levels.has(d.mode) || (d.mode !== 'hidden' && d.key in overrides)) && (q ? fuzzyScore(q, d.label) >= 0 || fuzzyScore(q, d.key) >= 0 : groups.includes(d.group))),
    [levels, q, groups.join(), overrides],
  )
  const changed = Object.keys(overrides).filter((k) => PRINTER_KEYS.some((d) => d.key === k)).length
  const close = () => set({ printerSettingsOpen: false })
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      className="printer-settings"
      title={`Printer settings${printer ? `: ${printer.vendor} ${printer.model}` : ''}`}
      splitFooter
      footer={
        <>
          <Button variant="ghost" onClick={() => { close(); openSettings('presets') }}>
            Save as a printer preset
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <NozzlePicker id="nozzle-ps" />
      <div className="search-in">
        <Icon name="search" />
        <label className="sr-only" htmlFor="ps-search">
          Search printer settings
        </label>
        <input id="ps-search" className="bare" placeholder={`Search ${PRINTER_KEYS.length} printer settings`} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      </div>
      {q ? null : <Seg label="Printer settings tab" size="sm" value={tab} onChange={setTab} options={TABS.map((t) => ({ value: t.id, label: t.label }))} />}
      <p className="sx-small sx-muted">
        {changed} changed. {printer ? 'Values start from the printer profile.' : 'No printer selected, so values start from the defaults.'} Machine G-code is set by the profile and is not editable here.
      </p>
      {defs.length === 0 ? <p className="sx-muted sx-small">No printer setting matches.</p> : null}
      <ul className="expert">
        {defs.map((d) => (
          <Field key={d.key} def={d} value={config[d.key]} overridden={d.key in overrides} idPrefix="ps" note={d.key === 'z_hop_types' ? zHopTypeNote(config) : undefined} onSet={(k, v) => setPrinterSetting(k, v, base)} />
        ))}
      </ul>
    </Dialog>
  )
}
