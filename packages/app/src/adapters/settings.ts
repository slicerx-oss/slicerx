// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's entry point to the full @slicerx/settings schema (labels, ranges, tiers, help). Startup code uses
// ./config instead, which needs only the defaults; this module loads on demand through ./load.
import type { PrintConfig, SettingDef, SettingValue } from '@slicerx/contracts'
import { formatValue as plainValue, goalEasy, isVisible, matchGoal, SETTINGS, settingDef, settingsForTier, toOrca } from '@slicerx/settings'

export { goalEasy, isVisible, matchGoal, settingDef, settingsForTier, SETTINGS, toOrca }

/** A value as the app shows it: a choice by its label, as its picker shows it, anything else as the settings package writes it. */
export function formatValue(def: SettingDef | undefined, v: SettingValue | undefined): string {
  const one = Array.isArray(v) && v.length > 0 && v.every((x) => x === v[0]) ? v[0] : v
  if (typeof one === 'string') {
    const k = def?.enumValues?.indexOf(one) ?? -1
    const label = k >= 0 ? def?.enumLabels?.[k] : undefined
    if (label) return label
  }
  return plainValue(def, v)
}

const GROUP_ORDER = ['quality', 'strength', 'speed', 'support', 'adhesion', 'cooling', 'temperature', 'extrusion', 'multimaterial', 'machine', 'gcode']

export function groupLabel(group: string): string {
  if (group === 'multimaterial') return 'Multi-material'
  if (group === 'gcode') return 'G-code'
  return group.charAt(0).toUpperCase() + group.slice(1)
}

export function groupRank(group: string): number {
  const i = GROUP_ORDER.indexOf(group)
  return i < 0 ? GROUP_ORDER.length : i
}

export { baseConfig, easyConfig, GOALS, isGoal, resolveConfig } from './config'

export function show(key: string, config: PrintConfig): string {
  const def: SettingDef | undefined = settingDef(key)
  return formatValue(def, config[key])
}
