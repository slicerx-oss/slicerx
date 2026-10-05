// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Compares two saved presets of one kind: every setting where they differ, with the label and the two values
// as the settings panel would show them. A setting one preset leaves alone shows "not set" (the default applies).
import type { SettingValue } from '@slicerx/contracts'
import { diffKeys } from './sync'
import type { UserPreset } from './store'

export interface CompareRow {
  key: string
  label: string
  a: string
  b: string
}

export interface SettingText {
  label(key: string): string
  format(key: string, v: SettingValue | undefined): string
}

/** The rows of a comparison, in the order the labels sort. */
export function comparePresets(a: UserPreset, b: UserPreset, text: SettingText): CompareRow[] {
  return diffKeys(a, b)
    .map((key) => ({ key, label: text.label(key), a: text.format(key, a.values[key]), b: text.format(key, b.values[key]) }))
    .sort((x, y) => x.label.localeCompare(y.label))
}

/** Presets that can be compared with `p`: the same kind, not itself. */
export function comparable(p: UserPreset, all: readonly UserPreset[]): UserPreset[] {
  return all.filter((o) => o.kind === p.kind && o.id !== p.id)
}
