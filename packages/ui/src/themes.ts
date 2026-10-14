// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Themes that ship with the package: Subban (default, dark), Subban light, and Forge, an
// example of a full rebrand (colors, gradient, fonts, radii, spacing).
import subbanLightFile from '../themes/subban-light.json'
import { createTheme, nocturne, subban } from './theme'
import { deriveScene, themeColors, validateThemeFile, type ThemeFile } from './themefile'

export { nocturne, subban }

const lightFile = validateThemeFile(subbanLightFile)
if (!lightFile.ok) throw new Error(`Bundled theme is invalid: ${lightFile.errors.join(' ')}`)
const light: ThemeFile = lightFile.theme

/** Subban light: Subban's palette meanings on a pale violet canvas. Text reaches 4.5:1 and glyph colors 3:1. */
export const subbanLight = createTheme({
  name: 'subban-light',
  scheme: 'light',
  colors: themeColors(light),
  scene: deriveScene(light),
})

/**
 * Subban light under its earlier name.
 * @deprecated Use `subbanLight`.
 */
export const nocturneLight = subbanLight

/** An example rebrand for integrators: warm accent, different faces, sharper corners, tighter grid. */
export const forge = createTheme({
  name: 'forge',
  scheme: 'dark',
  colors: {
    ink0: '#0f0f10',
    ink1: '#151516',
    ink2: '#1c1c1e',
    ink3: '#242427',
    ink4: '#2e2e32',
    line: '#3f3f46',
    lineSoft: '#28282c',
    fg: '#f4f1ea',
    muted: '#b3ada2',
    dim: '#7f7a70',
    purple: '#f0a43a',
    pink: '#e4573d',
    cyan: '#5fc5d6',
    green: '#7bd389',
    orange: '#ffb454',
    yellow: '#f2d16b',
    red: '#ff6b5e',
    onGrad: '#1b1208',
    shadow: 'rgb(0 0 0 / 75%)',
  },
  gradient: { from: 'var(--purple)', to: 'var(--pink)', angle: '160deg' },
  fonts: {
    display: '"Space Grotesk", "Arial Black", system-ui, sans-serif',
    body: '"Inter", ui-sans-serif, system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
    href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap',
  },
  radius: { xs: '2px', sm: '3px', md: '5px', lg: '8px' },
  spacing: { unit: 6 },
})

export const themes = { subban, subbanLight, forge } as const
export type ThemeName = keyof typeof themes
