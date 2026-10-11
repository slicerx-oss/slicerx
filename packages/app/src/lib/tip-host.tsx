// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's one tooltip: resolves an anchor's data attributes to copy from the registry (or the
// one-off text on the element), with the key chip taken from the active look's keymap.
import { keymapFor, TooltipHost, type KeyAction, type TipContent, type TipRow } from '@slicerx/ui'
import { useCallback, useEffect } from 'react'
import { useLookChoice } from '../first-run/look'
import { useApp } from '../state/store'
import { formatShortcut } from './keys'
import { SETTING_TIP, TIPS, type TipEntry } from './tips'

/** Chips for a chord: "Mod+Shift+Z" is one chip, "G G" is two. */
export function chordChips(chord: string | null | undefined): string[] {
  return chord ? chord.split(' ').filter(Boolean).map(formatShortcut) : []
}

type SettingTip = typeof import('./setting-tip').settingTip
let settingTip: SettingTip | null = null
let loading: Promise<SettingTip> | null = null

/** Setting tips need the settings data and figures, so they load after startup instead of with it. */
export function loadSettingTips(): Promise<SettingTip> {
  loading ??= import('./setting-tip').then((m) => (settingTip = m.settingTip))
  return loading
}

export function resolveTip(el: HTMLElement, map: Readonly<Record<string, string | null>>, developer = false): TipContent | null {
  const id = el.getAttribute('data-tip')
  if (id?.startsWith(SETTING_TIP)) {
    if (settingTip) return settingTip(id.slice(SETTING_TIP.length), developer)
    void loadSettingTips()
    return null
  }
  const entry: TipEntry | undefined = id ? (TIPS as Record<string, TipEntry>)[id] : undefined
  const title = entry?.title ?? el.getAttribute('data-tip-title')
  if (!title) return null
  const fixed = el.getAttribute('data-tip-key')
  const chord = entry?.key ? (entry.action ? map[entry.key as KeyAction] : entry.key) : fixed
  const body = entry?.body ?? el.getAttribute('data-tip-body') ?? undefined
  const reason = entry?.reason ?? el.getAttribute('data-tip-reason') ?? undefined
  const keys = chordChips(chord)
  const rows = tipRows(el.getAttribute('data-tip-rows'))
  return { title, ...(body ? { body } : {}), ...(keys.length ? { keys } : {}), ...(reason ? { reason } : {}), ...(rows ? { rows } : {}) }
}

/** A tip's rows from its attribute: three strings each, or none when the attribute is missing or malformed. */
function tipRows(raw: string | null): TipRow[] | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return null
    const rows = v.filter((r): r is TipRow => Array.isArray(r) && r.length === 3 && r.every((x) => typeof x === 'string'))
    return rows.length ? rows : null
  } catch {
    return null
  }
}

export function AppTooltips() {
  const choice = useLookChoice()
  const tips = useApp((s) => s.tooltips)
  const developer = useApp((s) => s.settingsMode === 'developer')
  const overrides = choice.overrides?.keys
  // fetched once the app is up; by the time a settings row is hovered it is here
  useEffect(() => {
    if (tips.enabled) void loadSettingTips()
  }, [tips.enabled])
  const resolve = useCallback((el: HTMLElement) => resolveTip(el, keymapFor(choice.id, overrides ?? {}), developer), [choice.id, overrides, developer])
  return <TooltipHost resolve={resolve} enabled={tips.enabled} media={tips.media} />
}
