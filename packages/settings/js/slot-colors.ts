// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The colors a filament slot and a new object take, and how a color value reads. On their own, with no import, so the
// app's startup shell can use them without pulling in the slot keys and the flush code (slot-settings.ts).

/** The colors new slots take, in order; the seventh is the edition's accent. */
export const defaultSlotColors = (accent: string): string[] => ['#f8f8f2', '#282a36', '#ff5555', '#50fa7b', '#8be9fd', '#ffb86c', accent, '#f1fa8c']

/** The colors the app gives new objects, and the parts of a project whose file names no color for their slot; the accent first. */
export const objectPaletteColors = (accent: string): string[] => [accent, '#8be9fd', '#50fa7b', '#ffb86c', '#ff79c6', '#f1fa8c']

/** A color as #rrggbb (with or without an alpha byte after it). */
export const isHex = (c: string | undefined): c is string => Boolean(c && /^#[0-9a-f]{6}$/i.test(c.slice(0, 7)))

/** `c` as lower case #rrggbb, else `fallback`. */
export function normalizeColor(c: string | undefined, fallback: string): string {
  return isHex(c) ? c.slice(0, 7).toLowerCase() : fallback
}
