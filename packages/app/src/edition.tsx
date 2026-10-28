// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The edition config (name, theme, printer families, AI defaults, legal links)
// the app was built with. Without one the neutral defaults apply.
import { setAssistantBrand, setProductColors, setProductName } from '@slicerx/contracts'
import { fontStack, neutralEdition, type EditionConfig, type PrinterFamily } from '@slicerx/edition-config'
import { subban, subbanLight, themeFromEdition, type Theme } from '@slicerx/ui'
import { objectPaletteColors } from '@slicerx/settings/slot-colors'
import { createContext, useContext } from 'react'

export const NEUTRAL: EditionConfig = neutralEdition()

export const EditionContext = createContext<EditionConfig>(NEUTRAL)

export function useEdition(): EditionConfig {
  return useContext(EditionContext)
}

let current: EditionConfig = NEUTRAL

/** The edition the app runs as, for code outside React. SlicerXApp sets it before the first render. */
export function setCurrentEdition(edition: EditionConfig): void {
  const changed = current !== edition
  current = edition
  // the edition's voice rides with the assistant's identity, so the prompt reads it wherever the name is read
  if (changed) setAssistantBrand({ ...edition.brand.assistant, voice: edition.ai?.brain?.voice })
  // the packages with no edition of their own (settings, the link client, the printer catalog) name it too
  setProductName(edition.brand.name)
  setProductColors(edition.brand.colors)
}

export function currentEdition(): EditionConfig {
  return current
}

/** Commands that need the modeling tools and are not a shelf tool; the tools' own commands take the flag from shelf-tools.ts. */
export const MODELING_COMMANDS = new Set(['dimensions-show'])

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

/**
 * The edition's theme on top of the user's light or dark choice: colors, visual properties, studio (scene) colors,
 * fonts and radii from `brand.theme`, with SlicerX values for anything it leaves out.
 */
export function editionTheme(edition: EditionConfig, scheme: 'dark' | 'light', chosen?: Theme): Theme {
  const base = chosen ?? (scheme === 'light' ? subbanLight : subban)
  const t = edition.brand.theme
  if (typeof t === 'string') return base
  // a family name alone would fall back to the browser's serif face wherever the font is missing
  return themeFromEdition(t, scheme, base, { name: edition.id, font: (family, role) => fontStack(family, role === 'mono' ? 'mono' : 'sans') })
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** New objects use the edition's accent for the active scheme, falling back to its shared purple token. */
export function brandAccent(edition: EditionConfig = current, scheme: 'dark' | 'light' = typeof document !== 'undefined' && document.documentElement.dataset['scheme'] === 'light' ? 'light' : 'dark'): string {
  const t = edition.brand.theme
  const purple = typeof t === 'string' ? undefined : t[scheme]?.visuals?.['--accent'] ?? t.tokens.visuals?.['--accent'] ?? t[scheme]?.colors?.['purple'] ?? t.tokens.colors?.['purple']
  return purple && HEX.test(purple) ? purple : subban.colors.purple
}

/** Colors for new objects and spare filament slots, the accent first. */
export function objectPalette(): string[] {
  return objectPaletteColors(brandAccent())
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
