// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the person's saved themes. Kept apart from the store so the store can import it.
import { validateThemeFile, type ThemeFile } from '@slicerx/ui/theme'

/** Keeps the entries that still pass the schema. */
export function loadUserThemes(raw: readonly unknown[] | undefined): ThemeFile[] {
  const out: ThemeFile[] = []
  for (const item of raw ?? []) {
    const r = validateThemeFile(item)
    if (r.ok) out.push(r.theme)
  }
  return out
}
