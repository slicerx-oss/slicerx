// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's one tooltip: resolves an anchor's data attributes to copy from the registry (or the
// one-off text on the element), with the key chip taken from the active look's keymap.
import { keymapFor, TooltipHost, type KeyAction, type TipContent, type TipRow } from '@slicerx/ui'
import { useCallback, useEffect } from 'react'
import { useLookChoice } from '../first-run/look'
import { useApp } from '../state/store'
import { formatShortcut } from './keys'
import type { TipEntry } from './tips'
import { SETTING_TIP } from './tip-ids'

/** Chips for a chord: "Mod+Shift+Z" is one chip, "G G" is two. */
export function chordChips(chord: string | null | undefined): string[] {
  return chord ? chord.split(' ').filter(Boolean).map(formatShortcut) : []
}

type SettingTip = typeof import('./setting-tip').settingTip
let settingTip: SettingTip | null = null
let registry: Readonly<Record<string, TipEntry>> | null = null
let loading: Promise<void> | null = null

/**
 * The tip text (the registry, and setting tips with their settings data and figures) loads right after startup
 * instead of with it. The app starts it on mount, well before a first hover can open a tip.
 */
export function loadTips(): Promise<void> {
  loading ??= Promise.all([
    import('./tips').then((m) => (registry = m.TIPS)),
    import('./setting-tip').then((m) => (settingTip = m.settingTip)),
  ]).then(() => undefined)
  return loading
}

/** Whether the tip text has arrived. */
export function tipsLoaded(): boolean {
  return registry !== null && settingTip !== null
}

export function resolveTip(el: HTMLElement, map: Readonly<Record<string, string | null>>, developer = false): TipContent | null {
  const id = el.getAttribute('data-tip')
  if (id?.startsWith(SETTING_TIP)) {
    if (settingTip) return settingTip(id.slice(SETTING_TIP.length), developer)
    void loadTips()
    return null
  }
  if (id && !registry) void loadTips()
  const entry: TipEntry | undefined = id ? registry?.[id] : undefined
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
  // Fetched once the app is up, with tips on or off: ? summons a tip and a disabled tool explains itself either way,
  // and a first ? before the text arrives would open the shortcut list instead.
  useEffect(() => {
    void loadTips()
  }, [])
  const resolve = useCallback((el: HTMLElement) => resolveTip(el, keymapFor(choice.id, overrides ?? {}), developer), [choice.id, overrides, developer])
  return <TooltipHost resolve={resolve} enabled={tips.enabled} media={tips.media} />
}
