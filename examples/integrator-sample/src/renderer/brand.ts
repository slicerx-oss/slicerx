// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Spoolhouse's brand as a SlicerX theme: amber on warm charcoal, with a light variant.
import { createTheme, subbanLight } from '@slicerx/embed'

const fonts = { body: 'system-ui, -apple-system, "Segoe UI", sans-serif', display: 'Georgia, "Times New Roman", serif' }

export const spoolhouseDark = createTheme({
  name: 'spoolhouse-dark',
  scheme: 'dark',
  colors: {
    ink0: '#171411', ink1: '#1d1915', ink2: '#241f1a', ink3: '#2c2620', ink4: '#362e27',
    line: '#4a3f35', lineSoft: '#3a322a', fg: '#f6efe6', muted: '#c4b6a6', dim: '#a39482',
    purple: '#e8a33d', pink: '#d9622b', onGrad: '#1a1205',
  },
  gradient: { from: '#e8a33d', to: '#d9622b', angle: '120deg' },
  fonts,
  radius: { md: '4px', lg: '6px' },
  scene: { top: '#2c2620', bottom: '#120f0c', glow: '#3a3027', plate: '#4a3f35', grid: '#8a7a68', edge: '#0a0806' },
})

export const spoolhouseLight = createTheme(
  {
    name: 'spoolhouse-light',
    colors: { purple: '#a8650f', pink: '#b34c1c', onGrad: '#ffffff' },
    gradient: { from: '#a8650f', to: '#b34c1c', angle: '120deg' },
    fonts,
    radius: { md: '4px', lg: '6px' },
  },
  subbanLight,
)
