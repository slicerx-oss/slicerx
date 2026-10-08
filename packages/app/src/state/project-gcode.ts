// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer G-code an opened project carries (docs/safety.md, project 3MF row). Text that is the printer's stock
// G-code is the same text SlicerX ships, so it needs nothing. Anything else waits for a person: the next slice they
// start shows the diff with its flagged lines, and they choose the project's G-code or the printer profile's (the
// default). Only the dialog's button chooses the project's; no command, tool or mimir skill can.
import type { SettingValue } from '@slicerx/contracts'
import type { GcodeChange } from '@slicerx/settings'
import { resolveConfig } from '../adapters/config'
import { slotConfig } from '../filament/slots'
import { get, set, toast } from './store'

export type GcodeChoice = 'project' | 'profile'

/** Reviews the G-code settings of a project just opened. Returns the number of settings that wait for a person. */
export async function reviewOpenedGcode(source: string, settings: Record<string, unknown>): Promise<number> {
  const { GCODE_TEXT_KEYS, importFlat, reviewProjectGcode } = await import('@slicerx/settings')
  const project = importFlat(Object.fromEntries(Object.entries(settings).filter(([k]) => GCODE_TEXT_KEYS.includes(k)))).config as Record<string, unknown>
  const s = get()
  const profile = s.profile
  const review = reviewProjectGcode({ project, profile: { ...resolveConfig(s.easy, s.overrides), ...slotConfig(s) }, model: profile?.printerId, limits: profile?.limits })
  if (review.changes.length === 0) {
    set({ projectGcode: null })
    return 0
  }
  set({ projectGcode: { source, changes: review.changes, asking: false } })
  const what = review.changes.length === 1 ? `its own ${review.changes[0]!.label}` : 'its own printer G-code'
  toast(`${source} has ${what}. You choose which G-code to use when you slice.`, 'info')
  return review.changes.length
}

let pending: ((choice: GcodeChoice | null) => void) | null = null

/** Shows the project's G-code and waits for the person's choice; null when they closed the dialog without one. */
export function askProjectGcode(): Promise<GcodeChoice | null> {
  const p = get().projectGcode
  if (!p) return Promise.resolve('profile')
  pending?.(null)
  return new Promise((resolve) => {
    pending = resolve
    set({ projectGcode: { ...p, asking: true } })
  })
}

/** The dialog's answer. `project` applies the project's G-code as overrides the person vouched for. */
export function answerProjectGcode(choice: GcodeChoice | null): void {
  const p = get().projectGcode
  // Only text a person may approve: an error flag stays blocked whatever the answer.
  if (choice === 'project' && p && !p.changes.every((c) => c.approvable)) throw new Error('This G-code cannot be approved.')
  const r = pending
  pending = null
  if (!p || choice === null) {
    if (p) set({ projectGcode: { ...p, asking: false } })
    r?.(null)
    return
  }
  if (choice === 'project') {
    const values = gcodeValues(p.changes)
    set((st) => ({ overrides: { ...st.overrides, ...values }, vouchedGcode: { ...st.vouchedGcode, ...values }, projectGcode: null }))
  } else set({ projectGcode: null })
  r?.(choice)
}

/** The project's G-code as overrides: per-filament text goes into its slot of the current list. */
export function gcodeValues(changes: readonly GcodeChange[]): Record<string, SettingValue> {
  const s = get()
  const base = { ...resolveConfig(s.easy, s.overrides), ...slotConfig(s) } as Record<string, SettingValue | undefined>
  const values: Record<string, SettingValue> = {}
  for (const c of changes) {
    if (c.slot === undefined) {
      values[c.key] = c.text
      continue
    }
    const cur = values[c.key] ?? base[c.key]
    const list = Array.isArray(cur) ? [...(cur as SettingValue[])] : [cur ?? '']
    while (list.length <= c.slot) list.push(list[list.length - 1] ?? '')
    list[c.slot] = c.text
    values[c.key] = list as unknown as SettingValue
  }
  return values
}

/** The override of `key` is the value a person chose from a project, unchanged since. */
export function isVouched(key: string, overrides: Record<string, SettingValue>, vouched: Record<string, SettingValue>): boolean {
  return key in vouched && JSON.stringify(overrides[key]) === JSON.stringify(vouched[key])
}
