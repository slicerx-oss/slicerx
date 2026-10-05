// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Edition fonts: fallback stacks for the family names a config gives, the @font-face rules for the
// files it bundles, and a warning for a family that neither the base nor the edition ships.
import type { EditionConfig } from './schema.ts'

export const SANS_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
export const MONO_FALLBACK = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/** Families the base app bundles (packages/app/src/styles/fonts.ts), so a config may name them without files. */
export const BASE_FONT_FAMILIES = ['Hanken Grotesk', 'Inter', 'IBM Plex Sans', 'IBM Plex Mono', 'JetBrains Mono', 'Unbounded'] as const

const GENERIC = /(^|,)\s*(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|math)\s*$/i

const quote = (family: string) => (/^["']/.test(family) ? family : `"${family}"`)

/** A config's font value as a full stack: each family quoted, then the fallback, so a missing face never lands on the browser's serif default. */
export function fontStack(value: string, kind: 'sans' | 'mono'): string {
  const families = value.split(',').map((f) => f.trim()).filter(Boolean)
  if (!families.length) return kind === 'mono' ? MONO_FALLBACK : SANS_FALLBACK
  const list = families.map((f) => (GENERIC.test(f) || /^(-apple-system|BlinkMacSystemFont)$/.test(f) ? f : quote(f))).join(', ')
  return GENERIC.test(list) ? list : `${list}, ${kind === 'mono' ? MONO_FALLBACK : SANS_FALLBACK}`
}

/** A font file with its URL in the build. */
export interface FontFace {
  family: string
  url: string
  weight?: string | undefined
  style?: 'normal' | 'italic' | undefined
}

const FORMATS: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' }

/** The @font-face rules for bundled files. */
export function fontFaceCss(faces: readonly FontFace[]): string {
  return faces
    .map((f) => {
      const ext = f.url.split('.').pop()?.toLowerCase() ?? ''
      const format = FORMATS[ext] ? ` format("${FORMATS[ext]}")` : ''
      return `@font-face{font-family:${quote(f.family)};src:url("${f.url}")${format};font-weight:${f.weight ?? '400'};font-style:${f.style ?? 'normal'};font-display:swap}`
    })
    .join('\n')
}

/** Families the theme names that no file and no base font provides. They show only where the font is installed. */
export function missingFonts(config: EditionConfig): string[] {
  const t = config.brand.theme
  if (t === 'nocturne') return []
  const have = new Set([...BASE_FONT_FAMILIES, ...(t.tokens.fontFiles ?? []).map((f) => f.family)].map((f) => f.toLowerCase()))
  const out = new Set<string>()
  for (const value of Object.values(t.tokens.fonts ?? {})) {
    const first = value?.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
    if (first && !GENERIC.test(first) && !have.has(first.toLowerCase())) out.add(first)
  }
  return [...out]
}
