// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag's colors: each theme key and the CSS custom property it sets. A host sets the properties on :root or
// any element around the view, or passes them as the `theme` option. Keep marks at 3:1 and label text at 4.5:1 against
// what they sit on (the bed, the view behind it and the band) when you change them.

/** The theme keys and the custom property each sets. */
export const EDGE_DRAG_PROPERTIES = {
  /** The band's glow and the edge line under it. */
  band: '--sx-edge-band',
  /** The line along the bed edge. */
  line: '--sx-edge-line',
  /** The commit line (dashed, solid once armed). */
  commit: '--sx-edge-commit',
  /** The halo under the lines and around the label text, so they keep their contrast over the band, bed and view. */
  halo: '--sx-edge-halo',
  /** The label text. */
  label: '--sx-edge-label',
  /** The label text once armed (it is also underlined, so the armed state never rests on color alone). */
  labelArmed: '--sx-edge-label-armed',
  /** The label's chevron. */
  chevron: '--sx-edge-chevron',
  /** The part's stand-in that flies to the plate bar on a drop. */
  drop: '--sx-edge-drop',
  /** The ring around the plate bar as the part lands. */
  ring: '--sx-edge-ring',
  /** The soft glow outside that ring. */
  ringGlow: '--sx-edge-ring-glow',
  /** The +N badge on the plate bar. */
  badge: '--sx-edge-badge',
  /** The +N badge's text. */
  badgeText: '--sx-edge-badge-text',
  /** The More plates list's surface. */
  menu: '--sx-edge-menu',
  /** The More plates list's text. */
  menuText: '--sx-edge-menu-text',
  /** The short release hint's surface. */
  hint: '--sx-edge-hint',
  /** The short release hint's text. */
  hintText: '--sx-edge-hint-text',
} as const

export type EdgeDragTheme = Partial<Record<keyof typeof EDGE_DRAG_PROPERTIES, string>>
