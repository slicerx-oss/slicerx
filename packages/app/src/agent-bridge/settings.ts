// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print settings panel for an agent: open a tab, open or close its sections, and pin or unpin settings, the way
// a person does, then read the panel back (workspaces/prepare/settings-view.ts).
import type { SettingIntent } from '@slicerx/contracts'
import { resolveSlots } from '../filament/slots'
import { get, set } from '../state/store'
import { SECTIONS } from '../workspaces/prepare/setting-sections'
import { EDITABLE_PROCESS, offeredTabs, settingsView } from '../workspaces/prepare/settings-view'
import { BridgeError } from './dom'

type Args = Record<string, unknown>

const strings = (v: unknown, name: string): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new BridgeError('invalid_input', `${name} is a list of names`)
  return v
}

/** Opens a tab, opens or closes sections of the tab shown, and pins or unpins settings; returns the panel as read back. */
export function setSettingsView(a: Args): Record<string, unknown> {
  const s = get()
  const offered = offeredTabs(Math.max(1, resolveSlots(s).filter((r) => r.used).length))
  let tab = s.settingsTab
  if (a['tab'] !== undefined) {
    const t = offered.find((x) => x.id === a['tab'] || x.label.toLowerCase() === String(a['tab']).toLowerCase())
    if (!t) throw new BridgeError('invalid_input', `no tab ${String(a['tab'])}; the tabs are ${offered.map((x) => x.id).join(', ')}`)
    tab = t.id
  }
  const section = (name: string) => {
    const sec = SECTIONS[tab as SettingIntent].find((x) => x.id === name || x.label.toLowerCase() === name.toLowerCase())
    if (!sec) throw new BridgeError('invalid_input', `the ${tab} tab has no section ${name}; it has ${SECTIONS[tab as SettingIntent].map((x) => x.id).join(', ')}`)
    return `${tab}/${sec.id}`
  }
  const setting = (name: string) => {
    const d = EDITABLE_PROCESS.find((x) => x.key === name || x.label?.toLowerCase() === name.toLowerCase())
    if (!d) throw new BridgeError('not_found', `no print setting ${name}`)
    return d.key
  }
  const open = strings(a['open'], 'open').map(section)
  const close = strings(a['close'], 'close').map(section)
  const pin = strings(a['pin'], 'pin').map(setting)
  const unpin = strings(a['unpin'], 'unpin').map(setting)
  set((st) => {
    const sections = { ...st.settingsSections }
    for (const k of open) sections[k] = true
    for (const k of close) sections[k] = false
    const pins = st.settingsPins.filter((k) => !unpin.includes(k))
    for (const k of pin) if (!pins.includes(k)) pins.push(k)
    return { settingsTab: tab, settingsSections: sections, settingsPins: pins.slice(-24) }
  })
  return settingsView(get())
}
