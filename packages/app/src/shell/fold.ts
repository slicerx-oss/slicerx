// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Slice sidebar section folded to its summary line, kept across launches. Simple mode keeps every section open
// and shows no fold, so it adds no controls there; Advanced and up, where the panels get long, can fold them.
import { effectiveMode, useLayout } from '../first-run/look'
import { set, useApp } from '../state/store'

/** Whether the section is open, and a setter; the setter is null in Simple mode, where sections do not fold. */
export function useFold(id: string): [boolean, ((open: boolean) => void) | null] {
  const folded = useApp((s) => s.sidebarFolds[id] === true)
  const simple = effectiveMode(useApp((s) => s.settingsMode), useLayout()) === 'simple'
  if (simple) return [true, null]
  return [!folded, (open) => set((s) => ({ sidebarFolds: { ...s.sidebarFolds, [id]: !open } }))]
}
