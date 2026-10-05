// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fonts a person can pick. All are open license (SIL OFL 1.1) and ship inside the app, so
// nothing loads from the network. "system" uses the operating system's own face.

export interface FontOption {
  id: string
  label: string
  /** The CSS font-family list. The bundled face first, then safe fallbacks. */
  css: string
}

const SYSTEM_UI = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
const SYSTEM_MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

export const UI_FONTS: readonly FontOption[] = [
  { id: 'hanken-grotesk', label: 'Hanken Grotesk', css: `"Hanken Grotesk Variable", "Hanken Grotesk", ${SYSTEM_UI}` },
  { id: 'inter', label: 'Inter', css: `"Inter Variable", "Inter", ${SYSTEM_UI}` },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', css: `"IBM Plex Sans", ${SYSTEM_UI}` },
  { id: 'system', label: 'System font', css: SYSTEM_UI },
]

export const MONO_FONTS: readonly FontOption[] = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono', css: `"JetBrains Mono Variable", "JetBrains Mono", ${SYSTEM_MONO}` },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', css: `"IBM Plex Mono", ${SYSTEM_MONO}` },
  { id: 'system', label: 'System monospace', css: SYSTEM_MONO },
]

export const DEFAULT_UI_FONT = 'hanken-grotesk'
export const DEFAULT_MONO_FONT = 'jetbrains-mono'
/** Titles keep the display face unless the person picked the system font. */
export const DISPLAY_FONT = `"Unbounded Variable", "Unbounded", "Arial Black", ${SYSTEM_UI}`

/** The person's font choice. "theme" means use the theme's suggestion, else the default. */
export interface FontChoice {
  ui: string
  mono: string
}

export const THEME_FONT_CHOICE: FontChoice = { ui: 'theme', mono: 'theme' }

export interface ResolvedFonts {
  display: string
  body: string
  mono: string
}

function pick(list: readonly FontOption[], user: string, suggested: string | undefined, fallback: string): FontOption {
  const find = (id: string | undefined) => list.find((f) => f.id === id)
  return (user !== 'theme' ? find(user) : undefined) ?? find(suggested) ?? find(fallback) ?? (list[0] as FontOption)
}

/** The user's choice wins over the theme's suggestion, which wins over the default. */
export function resolveFonts(user: FontChoice, suggested?: { ui?: string | undefined; mono?: string | undefined }): ResolvedFonts {
  const ui = pick(UI_FONTS, user.ui, suggested?.ui, DEFAULT_UI_FONT)
  const mono = pick(MONO_FONTS, user.mono, suggested?.mono, DEFAULT_MONO_FONT)
  return { display: ui.id === 'system' ? ui.css : DISPLAY_FONT, body: ui.css, mono: mono.css }
}
