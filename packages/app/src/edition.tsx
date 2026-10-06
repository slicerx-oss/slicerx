// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The edition config (name, theme, printer families, AI defaults, legal links)
// the app was built with. Without one the neutral defaults apply.
import { fontStack, neutralEdition, type EditionConfig, type PrinterFamily } from '@slicerx/edition-config'
import { createTheme, nocturne, nocturneLight, type Theme, type ThemeColors, type ThemeInput } from '@slicerx/ui'
import { createContext, useContext } from 'react'

export const NEUTRAL: EditionConfig = neutralEdition()

export const EditionContext = createContext<EditionConfig>(NEUTRAL)

export function useEdition(): EditionConfig {
  return useContext(EditionContext)
}

let current: EditionConfig = NEUTRAL

/** The edition the app runs as, for code outside React. SlicerXApp sets it before the first render. */
export function setCurrentEdition(edition: EditionConfig): void {
  current = edition
}

export function currentEdition(): EditionConfig {
  return current
}

/** The modeling tools ship in this edition (its geometry engine is built without them when they do not). */
export const MODELING_COMMANDS = new Set(['object-text', 'object-shape', 'object-sketch', 'object-push', 'object-fillet', 'object-holefit', 'object-thread', 'object-shell', 'project-values', 'dimensions-show'])

export function editionHasCad(edition: EditionConfig = current): boolean {
  return edition.features.cad
}

/**
 * The product name the app shows: the edition's brand name. Every user-facing mention of the app goes
 * through this, so a white-label edition never says SlicerX (only the Made possible by SlicerX credit does).
 */
export function appName(): string {
  return current.brand.name
}

/** Text written at module load with `{app}` where the product name goes, filled in when it is shown. */
export function branded(text: string): string {
  return text.replaceAll('{app}', appName())
}

/** The edition's theme on top of the user's light or dark choice. */
export function editionTheme(edition: EditionConfig, scheme: 'dark' | 'light', chosen?: Theme): Theme {
  const base = chosen ?? (scheme === 'light' ? nocturneLight : nocturne)
  const t = edition.brand.theme
  if (t === 'nocturne') return base
  // Drop unset keys: the theme types do not accept explicit undefined.
  const defined = <T extends object>(o: T | undefined) => (o ? (Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]-?: Exclude<T[K], undefined> }) : undefined)
  const input: ThemeInput = { name: edition.id }
  const colors = defined(t.tokens.colors)
  const fonts = defined(t.tokens.fonts)
  const radius = defined(t.tokens.radius)
  if (colors) input.colors = colors as Partial<ThemeColors>
  // a family name alone would fall back to the browser's serif face wherever the font is missing
  if (fonts) input.fonts = Object.fromEntries(Object.entries(fonts).map(([k, v]) => [k, fontStack(v, k === 'mono' ? 'mono' : 'sans')]))
  if (radius) input.radius = radius
  return createTheme(input, base)
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** The edition's accent as #rrggbb: its purple token, else Nocturne's. New objects take it, so an edition never shows the SlicerX purple. */
export function brandAccent(edition: EditionConfig = current): string {
  const t = edition.brand.theme
  const purple = t === 'nocturne' ? undefined : t.tokens.colors?.['purple']
  return purple && HEX.test(purple) ? purple : nocturne.colors.purple
}

/** Colors for new objects and spare filament slots, the accent first. */
export function objectPalette(): string[] {
  return [brandAccent(), '#8be9fd', '#50fa7b', '#ffb86c', '#ff79c6', '#f1fa8c']
}

/** Printer plugin ids to the families an edition can switch off. */
const FAMILY_OF: Record<string, PrinterFamily> = {
  'bambu-lan': 'bambu',
  moonraker: 'moonraker',
  prusalink: 'prusalink',
  octoprint: 'octoprint',
  duet: 'duet',
  creality: 'creality',
  elegoo: 'elegoo',
  snapmaker: 'snapmaker',
}

export function printerAllowed(edition: EditionConfig, plugin: string): boolean {
  const family = FAMILY_OF[plugin]
  return family ? edition.features.printers[family] : true
}
