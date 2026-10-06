// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// React-free entry: "@slicerx/ui/icons". Icon markup and the mark geometry for native renderers.
export { ICON_PATHS, ICON_GROUPS, ICON_COUNT } from './icons/icon-paths'
export type { IconName } from './icons/icon-paths'
export { MARK_PATH, MARK_VIEWBOX, MARK_CUTS, markRings, markCutFor, LEGACY_MARK_PATH, markBars } from './icons/mark-path'
export type { MarkCut, MarkRing, MarkRole } from './icons/mark-path'
export { perchShapes, perchCutFor } from './icons/perch-path'
export type { PerchCut, PerchShapes } from './icons/perch-path'
/** Drawing contract shared by every icon: a 24px grid, this stroke, round caps and joins, no fill. */
export const ICON_VIEWBOX = '0 0 24 24'
export const ICON_STROKE = 1.75
