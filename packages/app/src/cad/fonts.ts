// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fonts installed on this computer, for the text tool's font picker. Chromium based browsers and the desktop
// app expose them through queryLocalFonts (after a permission prompt); elsewhere the list is empty and the picker
// offers the file chooser only. The engine reads TrueType and OpenType outlines, so only those are listed.
import { toBase64 } from '../state/import-auto'

/** The part of the browser's FontData the picker uses. */
export interface LocalFont {
  family: string
  style: string
  postscriptName: string
  blob(): Promise<Blob>
}

export interface FontChoice {
  family: string
  font: LocalFont
}

type FontApi = { queryLocalFonts?: () => Promise<LocalFont[]> }

export const localFontsAvailable = (w: FontApi = globalThis as unknown as FontApi): boolean => typeof w.queryLocalFonts === 'function'

/** One entry per family, the regular style where there is one, sorted by name. */
export function pickFamilies(fonts: readonly LocalFont[]): FontChoice[] {
  const best = new Map<string, LocalFont>()
  for (const f of fonts) {
    if (!f.family) continue
    const have = best.get(f.family)
    if (!have || rank(f) < rank(have)) best.set(f.family, f)
  }
  return [...best.entries()].map(([family, font]) => ({ family, font })).sort((a, b) => a.family.localeCompare(b.family, 'en-US'))
}

const rank = (f: LocalFont): number => {
  const s = f.style.toLowerCase()
  if (s === 'regular' || s === 'book' || s === 'roman') return 0
  return /italic|oblique/.test(s) ? 2 : 1
}

/** Asks for the installed fonts. Returns an empty list when the browser has none to offer or the person declined. */
export async function listLocalFonts(w: FontApi = globalThis as unknown as FontApi): Promise<FontChoice[]> {
  if (!w.queryLocalFonts) return []
  try {
    return pickFamilies(await w.queryLocalFonts())
  } catch {
    return []
  }
}

/** The font's file as base64, which the engine takes as fontBase64. */
export async function fontBase64(choice: FontChoice): Promise<string> {
  return toBase64(await choice.font.blob().then((b) => b.arrayBuffer()))
}
