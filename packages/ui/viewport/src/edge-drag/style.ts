// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag's look: the bands off the bed while a part moves, the More plates list, the drop into the plate bar
// and the short release hint. Mounted only while a part moves; it takes no pointer events. Every color is a custom
// property a host can set on :root, on any element around the view, or through the `theme` option; unset, each falls
// back to the app's own tokens and then to SlicerX's dark values. The rules go into the page once, on the first drag.
import { EDGE_DRAG_PROPERTIES, type EdgeDragTheme } from './properties'

export { EDGE_DRAG_PROPERTIES, type EdgeDragTheme } from './properties'

// Each property, then the app's token it follows, then a plain dark value for a host with neither.
const band = 'var(--sx-edge-band, var(--accent, #bd93f9))'
const C = {
  band,
  line: `var(--sx-edge-line, ${band})`,
  commit: `var(--sx-edge-commit, ${band})`,
  halo: 'var(--sx-edge-halo, color-mix(in srgb, var(--ink-0, #282a36) 82%, transparent))',
  label: 'var(--sx-edge-label, var(--fg, #f8f8f2))',
  // the accent's text color drawn toward the body text, so it holds its contrast on the bright armed band
  labelArmed: 'var(--sx-edge-label-armed, color-mix(in srgb, var(--purple-text, #d1b3fb) 45%, var(--fg, #f8f8f2)))',
  chevron: 'var(--sx-edge-chevron, var(--sx-edge-label-armed, color-mix(in srgb, var(--purple-text, #d1b3fb) 45%, var(--fg, #f8f8f2))))',
  drop: `var(--sx-edge-drop, ${band})`,
  ring: `var(--sx-edge-ring, ${band})`,
  ringGlow: 'var(--sx-edge-ring-glow, var(--accent-ring, color-mix(in srgb, #bd93f9 45%, transparent)))',
  badge: `var(--sx-edge-badge, ${band})`,
  badgeText: 'var(--sx-edge-badge-text, var(--ink-0, #282a36))',
  menu: 'var(--sx-edge-menu, var(--surface-menu, rgba(57, 59, 72, 0.97)))',
  menuText: 'var(--sx-edge-menu-text, var(--fg, #f8f8f2))',
  hint: 'var(--sx-edge-hint, var(--surface-float, rgba(57, 59, 72, 0.94)))',
  hintText: 'var(--sx-edge-hint-text, var(--fg, #f8f8f2))',
}

export const EDGE_DRAG_CSS = `
.sx-edge-drag { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 1; font-family: var(--f-body, ui-sans-serif, system-ui, sans-serif); }
.sx-edge-bands { position: absolute; inset: 0; transition: opacity 160ms ease-out; }
.sx-edge-bands[data-out] { opacity: 0; }
.sx-edge-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.sx-edge-stop { stop-color: ${C.band}; }
.sx-edge-line { stroke: ${C.line}; stroke-width: 2; }
.sx-edge-commit { stroke: ${C.commit}; stroke-width: 1.5; stroke-dasharray: 6 6; }
.sx-edge-commit[data-armed] { stroke-width: 2.5; stroke-dasharray: none; }
.sx-edge-halo { stroke: ${C.halo}; stroke-width: 5; stroke-linecap: round; }
.sx-edge-commit-halo { stroke-width: 4.5; stroke-dasharray: 6 6; stroke-dashoffset: 0; }
.sx-edge-commit-halo[data-armed] { stroke-width: 6; stroke-dasharray: none; }
.sx-edge-label { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 4px; font-size: 15px; font-weight: 600; line-height: 20px; white-space: nowrap; color: ${C.label}; text-shadow: 0 0 1px ${C.halo}, 0 0 3px ${C.halo}, 0 0 8px ${C.halo}; will-change: transform; }
.sx-edge-text { text-decoration: underline 2px transparent; text-underline-offset: 4px; }
.sx-edge-label[data-armed] { color: ${C.labelArmed}; }
.sx-edge-label[data-armed] .sx-edge-text { text-decoration-color: ${C.commit}; }
.sx-edge-chev { width: 14px; height: 14px; flex: none; overflow: visible; }
.sx-edge-chev path { fill: none; stroke: ${C.chevron}; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
:root[data-phone] .sx-edge-label, .sx-edge-drag[data-compact] .sx-edge-label { font-size: 13px; }
.sx-edge-more { position: absolute; left: 0; top: 0; min-width: 168px; padding: 4px; border-radius: var(--r-md, 10px); background: ${C.menu}; box-shadow: var(--shadow-pop, 0 6px 14px -4px rgb(0 0 0 / 28%)); -webkit-backdrop-filter: var(--lift-glass, none); backdrop-filter: var(--lift-glass, none); color: ${C.menuText}; font-size: 13px; }
:root[data-scheme="light"] .sx-edge-more { border: 1px solid rgba(0, 0, 0, 0.12); }
.sx-edge-more-row { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: var(--r-sm, 6px); }
.sx-edge-more-row[data-hot] { background: color-mix(in srgb, ${C.band} 14%, transparent); color: ${C.labelArmed}; font-weight: 600; }
.sx-edge-more-thumb { width: 16px; height: 16px; border-radius: var(--r-xs, 4px); background: color-mix(in srgb, ${C.menuText} 22%, transparent); }
.sx-edge-fly { position: absolute; left: 0; top: 0; border-radius: var(--r-sm, 6px); border: 2px solid ${C.drop}; background: color-mix(in srgb, ${C.drop} 40%, transparent); transform-origin: 50% 50%; }
.sx-edge-ring { position: absolute; left: 0; top: 0; border: 2px solid ${C.ring}; border-radius: 12px; box-shadow: 0 0 0 4px ${C.ringGlow}; opacity: 0; }
.sx-edge-badge { position: absolute; left: 0; top: 0; min-width: 26px; height: 18px; padding: 0 6px; border-radius: var(--r-pill, 999px); background: ${C.badge}; color: ${C.badgeText}; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; opacity: 0; }
.sx-edge-hint { position: absolute; left: 0; top: 0; padding: 8px 16px; border-radius: var(--r-pill, 999px); background: ${C.hint}; box-shadow: var(--shadow-float, 0 4px 10px -2px rgb(0 0 0 / 40%)); -webkit-backdrop-filter: var(--lift-glass, none); backdrop-filter: var(--lift-glass, none); color: ${C.hintText}; font-size: 13px; white-space: nowrap; }
:root[data-scheme="light"] .sx-edge-hint { border: 1px solid rgba(0, 0, 0, 0.12); }
@media (prefers-reduced-motion: reduce) { .sx-edge-bands { transition: none; } }
:root[data-motion="reduced"] .sx-edge-bands { transition: none; }
`

let injected: HTMLStyleElement | null = null

/** Puts the rules into the page once; a page that removed them gets them again. */
export function injectEdgeDragStyle(doc: Document = document): void {
  if (injected && injected.isConnected && injected.ownerDocument === doc) return
  const el = doc.createElement('style')
  el.setAttribute('data-sx-edge-drag', '')
  el.textContent = EDGE_DRAG_CSS
  doc.head.appendChild(el)
  injected = el
}

/** The theme as inline custom properties on the overlay, over whatever the page sets. */
export function applyEdgeDragTheme(el: HTMLElement, theme: EdgeDragTheme | undefined): void {
  if (!theme) return
  for (const [k, v] of Object.entries(theme)) {
    const prop = EDGE_DRAG_PROPERTIES[k as keyof typeof EDGE_DRAG_PROPERTIES]
    if (prop && typeof v === 'string' && v) el.style.setProperty(prop, v)
  }
}
