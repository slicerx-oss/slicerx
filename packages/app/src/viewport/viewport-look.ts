// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D view's look follows the theme: Dark precision on a dark theme, Light studio on a light one. The Subban themes
// take the preset whole; any other theme keeps its own backdrop colors and takes the lighting, materials and plate. The
// look in use is kept here so the app link can read it back (look.get).
import { lookForScheme, type LookPresetId, type Viewport, type ViewportLook } from '@slicerx/viewport'

/** The themes whose studio the presets were drawn for; their backdrop comes from the preset. */
const PRESET_THEMES = new Set(['subban', 'subban-dark', 'subban-light'])

export interface ViewportLookState {
  /** The preset in use. */
  preset: LookPresetId
  /** Whether the theme kept its own backdrop colors (a theme other than Subban). */
  themeBackdrop: boolean
  /** The full look the 3D view draws with, as the viewport reads it back. */
  look: ViewportLook
}

/** The look for the theme on the root element: its scheme picks the preset, its name whether the backdrop is the preset's. */
export function themeLook(root: HTMLElement = document.documentElement): { preset: LookPresetId; themeBackdrop: boolean; look: ViewportLook } {
  const scheme = root.dataset['scheme'] === 'light' ? 'light' : 'dark'
  const name = root.dataset['sxTheme']
  const themeBackdrop = name !== undefined && !PRESET_THEMES.has(name)
  return { ...lookForScheme(scheme, { themeBackdrop }), themeBackdrop }
}

let active: ViewportLookState | null = null

/** Sets the theme's look on the view (the one path that sets it) and records it for read-back. */
export function syncViewportLook(vp: Pick<Viewport, 'setLook' | 'look'>, root?: HTMLElement): ViewportLookState {
  const t = themeLook(root)
  vp.setLook(t.look)
  active = { preset: t.preset, themeBackdrop: t.themeBackdrop, look: vp.look() }
  return active
}

/** The look the 3D view draws with now, or null while no 3D view is up (the 2D fallback, or before it starts). */
export function viewportLookState(): ViewportLookState | null {
  return active ? structuredClone(active) : null
}

/** The 3D view went away. */
export function clearViewportLook(): void {
  active = null
}
