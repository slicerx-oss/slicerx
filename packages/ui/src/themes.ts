// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Themes that ship with the package: Nocturne (default, dark), Nocturne Light, and Forge, an
// example of a full rebrand (colors, gradient, fonts, radii, spacing).
import { createTheme, nocturne } from './theme'

export { nocturne }

/** SlicerX light: the same palette meanings on a warm off-white canvas. Text reaches 4.5:1 and glyph colors 3:1. */
export const nocturneLight = createTheme({
  name: 'nocturne-light',
  scheme: 'light',
  colors: {
    ink0: '#f7f6f3',
    ink1: '#f3f2ee',
    ink2: '#efede8',
    ink3: '#e8e5df',
    ink4: '#e2dfd8',
    line: '#d9d5cd',
    lineSoft: '#e2dfd8',
    fg: '#2a2833',
    muted: '#5b5763',
    dim: '#6b6874',
    purple: '#7349c9',
    pink: '#a3378b',
    cyan: '#1f7a86',
    green: '#2b7536',
    orange: '#c8661b',
    yellow: '#9a6b00',
    red: '#931d27',
    onGrad: '#ffffff',
    shadow: 'rgb(42 40 51 / 20%)',
  },
})

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

export const themes = { nocturne, nocturneLight, forge } as const
export type ThemeName = keyof typeof themes
