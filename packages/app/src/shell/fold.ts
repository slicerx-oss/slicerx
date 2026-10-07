// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Slice sidebar section folded to its summary line, kept across launches.
import { set, useApp } from '../state/store'

/** Whether the section is open, and a setter. Sections start open. */
export function useFold(id: string): [boolean, (open: boolean) => void] {
  const folded = useApp((s) => s.sidebarFolds[id] === true)
  return [!folded, (open) => set((s) => ({ sidebarFolds: { ...s.sidebarFolds, [id]: !open } }))]
}
