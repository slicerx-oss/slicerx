// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeps the files of the bundled themes in use, so the next start shows them without the theme bundle.
import { BUNDLED_THEMES } from '@slicerx/ui/theme-bundle'
import type { ThemeFile, ThemeIds } from '@slicerx/ui/theme'
import { set } from '../state/store'

/** The bundled files for both slots, Subban left out (the app always has it). */
export function themeCacheFor(ids: ThemeIds): ThemeFile[] {
  return BUNDLED_THEMES.filter((t) => (t.id === ids.dark || t.id === ids.light) && t.family !== 'subban')
}

export function cacheThemes(ids: ThemeIds): void {
  set({ themeCache: themeCacheFor(ids) })
}
