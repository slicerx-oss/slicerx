// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How a plate's settings differ from the goal they started from: the Goal tile stays picked with an edited mark, its
// tip lists the settings, and pressing it goes back. A project that matches no goal starts from the nearest one.
import type { EasyGoal, PrintConfig, SettingValue } from '@slicerx/contracts'
import { goalConfig, goalKeys } from '../adapters/config'
import { formatValue, settingDef } from '../adapters/settings'

export interface GoalEdit {
  key: string
  label: string
  /** The plate's value, as the settings show it. */
  now: string
  /** The goal's own value. */
  goal: string
}

const same = (a: SettingValue | undefined, b: SettingValue | undefined) => JSON.stringify(a) === JSON.stringify(b)

// the ones people pick a goal for come first in the tip
const FIRST = ['layer_height', 'smart_layer', 'wall_loops', 'sparse_infill_density']

/** The settings a goal decides where `cfg` differs from what `base` gives on this printer. */
export function goalEdits(cfg: PrintConfig, base: EasyGoal): GoalEdit[] {
  const stock = goalConfig(base)
  const rank = (k: string) => (FIRST.includes(k) ? FIRST.indexOf(k) : FIRST.length)
  return goalKeys()
    .filter((k) => !same(cfg[k], stock[k]))
    .sort((a, b) => rank(a) - rank(b))
    .map((key) => {
      const def = settingDef(key)
      const label = def?.label ?? key
      // a choice whose label repeats the setting's name ("sleipnir: Quality") reads once in the list
      const show = (v: SettingValue | undefined) => {
        const text = formatValue(def, v)
        return text.toLowerCase().startsWith(`${label.toLowerCase()}: `) ? text.slice(label.length + 2) : text
      }
      return { key, label, now: show(cfg[key]), goal: show(stock[key]) }
    })
}

/** The tip for an edited goal: a row per setting (its name, the plate's value, the goal's), then how to go back. */
export function goalEditsTip(edits: readonly GoalEdit[], goalName: string, shown = 4): { rows: [string, string, string][]; body: string } {
  const rows = edits.slice(0, shown).map((e): [string, string, string] => {
    // the goal's value drops the unit the plate's already shows: "0.18 mm (0.2)"
    const unit = / [^\d\s]+$/.exec(e.now)?.[0]
    const goal = unit && e.goal.endsWith(unit) ? e.goal.slice(0, -unit.length) : e.goal
    return [e.label, e.now, `(${goal})`]
  })
  const more = edits.length - shown
  return { rows, body: `${more > 0 ? `And ${more} more. ` : ''}Press ${goalName} to go back to its settings.` }
}

const num = (v: SettingValue | undefined): number => Number(Array.isArray(v) ? v[0] : v)

/**
 * The goal whose layer height is nearest `cfg`'s, for settings that match none (an opened project). `values` are the
 * printer's own per-goal values when it has them. A tie goes to Standard, then Fine, then Draft.
 */
export function nearestGoal(cfg: Readonly<Record<string, SettingValue>>, values?: Partial<Record<EasyGoal, Record<string, SettingValue>>>): EasyGoal {
  const h = num(cfg['layer_height'])
  let best: EasyGoal = 'standard'
  if (!Number.isFinite(h)) return best
  let gap = Number.POSITIVE_INFINITY
  for (const g of ['standard', 'fine', 'draft', 'strong'] as const) {
    const d = Math.abs(num(values?.[g]?.['layer_height'] ?? goalConfig(g)['layer_height']) - h)
    if (d < gap - 1e-9) {
      gap = d
      best = g
    }
  }
  return best
}
