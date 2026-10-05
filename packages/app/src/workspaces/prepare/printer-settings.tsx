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
import { EDITABLE, Field, visibleLevels } from './expert-settings'
import { printerBase } from './printer-base'
import { NozzlePicker } from './nozzle-picker'

const TABS: { id: string; label: string; groups: string[] }[] = [
  { id: 'basic', label: 'Basic information', groups: ['machine'] },
  { id: 'extruder', label: 'Extruder and retraction', groups: ['retraction'] },
  { id: 'motion', label: 'Motion ability', groups: ['motion'] },
  { id: 'multi', label: 'Multimaterial', groups: ['multimaterial'] },
  { id: 'cooling', label: 'Cooling', groups: ['cooling'] },
]

const PRINTER_KEYS = SETTINGS.filter((d) => d.section === 'printer' && EDITABLE.has(d.type))

export function setPrinterSetting(key: string, value: SettingValue | undefined, base: PrintConfig | undefined): void {
  set((s) => {
    const next = { ...s.overrides }
    if (value === undefined) delete next[key]
    else {
      // Machine limits and the like hold one value per mode; a field edits the first and keeps the rest.
      const cur = (next[key] ?? (base as Record<string, SettingValue> | undefined)?.[key]) as SettingValue | undefined
      next[key] = Array.isArray(cur) && cur.length > 1 && Array.isArray(value) ? ([value[0], ...cur.slice(1)] as SettingValue) : value
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
  const defs: SettingDef[] = useMemo(
    () =>
      PRINTER_KEYS.filter((d) => levels.has(d.mode) && (q ? fuzzyScore(q, d.label) >= 0 || fuzzyScore(q, d.key) >= 0 : groups.includes(d.group))),
    [levels, q, groups.join()],
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
          <Field key={d.key} def={d} value={config[d.key]} overridden={d.key in overrides} idPrefix="ps" onSet={(k, v) => setPrinterSetting(k, v, base)} />
        ))}
      </ul>
    </Dialog>
  )
}
