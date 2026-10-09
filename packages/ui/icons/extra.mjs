// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Icons added on top of the 68 base ones in icons/base.mjs. Same contract: a 24px grid,
// drawn for stroke 1.75 with round caps and joins, no fill except tiny dots, currentColor.
// Each value is the inner SVG markup. scripts/gen-icons.mjs merges these after the design set.

const r2 = (v) => String(Math.round(v * 100) / 100)
const polar = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}
const pt = ([x, y]) => `${r2(x)} ${r2(y)}`

/** A cog with `teeth` teeth, drawn as one closed path. */
function gear(cx, cy, outer, base, teeth, tipHalf, baseHalf) {
  const step = 360 / teeth
  let d = ''
  for (let i = 0; i < teeth; i++) {
    const a = i * step - 90
    const p1 = polar(cx, cy, base, a - baseHalf)
    const p2 = polar(cx, cy, outer, a - tipHalf)
    const p3 = polar(cx, cy, outer, a + tipHalf)
    const p4 = polar(cx, cy, base, a + baseHalf)
    const next = polar(cx, cy, base, a + step - baseHalf)
    d += `${i === 0 ? 'M' : 'L'}${pt(p1)}L${pt(p2)}L${pt(p3)}L${pt(p4)}A${r2(base)} ${r2(base)} 0 0 1 ${pt(next)}`
  }
  return d + 'z'
}

/** A five point star as one closed path. */
function star(cx, cy, outer, inner) {
  const pts = []
  for (let i = 0; i < 10; i++) pts.push(polar(cx, cy, i % 2 ? inner : outer, -90 + i * 36))
  return 'M' + pts.map(pt).join('L') + 'z'
}

/** Scale a list of points toward their center, for marking one face of a cube. */
function inset(points, k) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length
  return 'M' + points.map(([x, y]) => pt([cx + (x - cx) * k, cy + (y - cy) * k])).join('L') + 'z'
}

// The isometric cube used by the view icons.
const CUBE = '<path d="M12 3l7.5 4.25v9L12 20.5l-7.5-4.25v-9z"/><path d="M4.5 7.25L12 11.5l7.5-4.25M12 11.5v9"/>'
const FACE_TOP = [[12, 3], [19.5, 7.25], [12, 11.5], [4.5, 7.25]]
const FACE_LEFT = [[4.5, 7.25], [12, 11.5], [12, 20.5], [4.5, 16.25]]
const FACE_RIGHT = [[19.5, 7.25], [12, 11.5], [12, 20.5], [19.5, 16.25]]

// Shared parts.
const PLATE = '<path d="M7.5 5.5h13l-4 12h-13z"/>'
const NOZZLE_TOP = '<rect x="6.5" y="3.5" width="11" height="4" rx="1.5"/><path d="M8.5 7.5h7l-2 4h-3z"/>'
const BELL = '<path d="M5 15.5V10a7 7 0 0 1 14 0v5.5l1.5 1.5h-17z"/><path d="M10 19.5a2 2 0 0 0 4 0"/>'
const CLOUD = '<path d="M7.5 18.5a4.5 4.5 0 0 1-.9-8.9A5.25 5.25 0 0 1 17 10a4.25 4.25 0 0 1-.5 8.5z"/>'
const EYE = '<path d="M2.5 12c2.2-4 5.5-6.5 9.5-6.5s7.3 2.5 9.5 6.5c-2.2 4-5.5 6.5-9.5 6.5S4.7 16 2.5 12z"/><circle cx="12" cy="12" r="3"/>'
const FRAME_CORNERS = '<path d="M3.5 8V5.5a2 2 0 0 1 2-2H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16"/>'
const DASH_FRAME = '<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="2 2.6"/>'
const PENCIL = '<path d="M18.5 12l2.5 2.5-6.5 6.5H12v-2.5z"/>'
const SLASH = '<path d="M3.5 3.5l17 17"/>'
const SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5L16 16"/>'
const DOT = (x, y) => `<circle cx="${x}" cy="${y}" r="1.5" fill="currentColor" stroke="none"/>`
const STAR = star(12, 12.75, 8.75, 3.9)
const GEAR = gear(12, 12, 9, 6.6, 8, 8, 14)

export const EXTRA_ICONS = {
  // Materials
  pla: '<path d="M5.5 18.5c0-8.5 5.5-14 15-14.5-.5 9.5-6 15-15 14.5z"/><path d="M3.5 20.5l10-10"/>',
  petg: '<path d="M10 3.5h4"/><path d="M10.5 3.5V6.5L8 10v9a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 16 19v-9l-2.5-3.5v-3"/><path d="M8 13.5h8"/>',
  abs: '<rect x="3.5" y="9.5" width="17" height="10" rx="1.5"/><path d="M6.5 9.5V7a1 1 0 0 1 1-1H10a1 1 0 0 1 1 1v2.5M13 9.5V7a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v2.5"/>',
  asa: '<path d="M3.5 17.5h17M8 20.5h8"/><path d="M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M12 6v2.5M5.6 10.6l1.8 1.8M18.4 10.6l-1.8 1.8"/>',
  tpu: '<path d="M7 3.5h10M7 20.5h10"/><path d="M12 3.5V6l4.5 1.5-9 3 9 3-9 3 4.5 1.5v2.5"/>',
  nylon: '<path d="M3.5 8.5c3 0 5.5 7 8.5 7s5.5-7 8.5-7"/><path d="M3.5 15.5c3 0 5.5-7 8.5-7s5.5 7 8.5 7"/>',
  resin: '<path d="M12 3.5c2.7 3.4 4.5 5.8 4.5 8a4.5 4.5 0 0 1-9 0c0-2.2 1.8-4.6 4.5-8z"/><path d="M3.5 15v3.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V15"/>',
  'carbon-fiber': '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 9.5l6-6M3.5 15.5l12-12M9.5 20.5l11-11M15.5 20.5l5-5"/>',
  silk: '<path d="M3.5 8c3-2.5 6-2.5 8.5 0s5.5 2.5 8.5 0v8c-3 2.5-6 2.5-8.5 0s-5.5-2.5-8.5 0z"/><path d="M7 11.5c1.5 0 3 .8 3.5 2"/>',
  matte: '<circle cx="12" cy="12" r="8.5"/><path d="M7.5 12a4.5 4.5 0 0 1 4.5-4.5"/>',
  glow: '<path d="M16.5 15.5A7 7 0 1 1 8.5 6a5.5 5.5 0 0 0 8 9.5z"/><path d="M17.5 3.5v4M15.5 5.5h4M20 10v2M19 11h2"/>',
  wood: '<ellipse cx="7" cy="12" rx="3.5" ry="7"/><ellipse cx="7" cy="12" rx="1" ry="2.5"/><path d="M7 5h10a3.5 7 0 0 1 0 14H7"/><path d="M13 9h2.5M14.5 15H17"/>',
  // Filament state
  'spool-empty': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 9.5V4M14.2 13.25l4.7 2.75M9.8 13.25l-4.7 2.75"/>',
  'spool-low': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="4.75" stroke-dasharray="2 1.75"/><path d="M12 7.25V4"/>',
  'dry-box': '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 8h17"/><circle cx="12" cy="14.25" r="3.5"/><path d="M12 14.25h.01"/>',
  humidity: '<path d="M9.5 4c3 3.8 5 6.6 5 9.5a5 5 0 0 1-10 0c0-2.9 2-5.7 5-9.5z"/><path d="M17.5 12.5c1.5 1.9 2.5 3.3 2.5 4.75a2.5 2.5 0 0 1-5 0c0-1.45 1-2.85 2.5-4.75z"/>',
  'filament-runout': '<path d="M12 2.5v6" stroke-dasharray="0 3"/><rect x="6.5" y="11.5" width="11" height="4" rx="1.5"/><path d="M8.5 15.5h7l-2 4.5h-3z"/>',
  'filament-change': '<circle cx="7" cy="7" r="3.5"/><circle cx="17" cy="17" r="3.5"/><path d="M7 7h.01M17 17h.01"/><path d="M13 5.5h2.5a3 3 0 0 1 3 3V11M16.5 9l2 2 2-2"/><path d="M11 18.5H8.5a3 3 0 0 1-3-3V13M3.5 15l2-2 2 2"/>',
  purge: NOZZLE_TOP + '<path d="M12 14h.01"/><path d="M7 20.5h10M8.5 20.5c0-2.5 1.5-3.5 3.5-3.5s3.5 1 3.5 3.5"/>',
  flush: NOZZLE_TOP + '<path d="M9.5 14.5v3M12 14.5v6M14.5 14.5v3"/>',
  // Hardware
  hotend: '<path d="M7 3.5h10M7 6.5h10M10.5 6.5v3M13.5 6.5v3"/><rect x="6.5" y="9.5" width="11" height="5" rx="1.5"/><path d="M9.5 14.5h5l-1.5 3.5h-2z"/><path d="M17.5 12h3"/>',
  extruder: '<circle cx="7.5" cy="12" r="3"/><circle cx="16.5" cy="12" r="3"/><path d="M7.5 12h.01M16.5 12h.01"/><path d="M12 3v18"/>',
  'direct-drive': '<rect x="5.5" y="3.5" width="13" height="7.5" rx="1.5"/><circle cx="12" cy="7.25" r="1.75"/><rect x="8" y="11" width="8" height="3.5" rx="1"/><path d="M9.5 14.5h5l-1.5 4h-2z"/>',
  bowden: '<rect x="3.5" y="3.5" width="7" height="6" rx="1.5"/><path d="M7 6.5h.01"/><path d="M10.5 6.5H14a3.5 3.5 0 0 1 3.5 3.5v4"/><path d="M14.5 14h6l-2 4h-2z"/>',
  heatbreak: '<path d="M9.5 3.5v6l1.5 1.5v2l-1.5 1.5v6M14.5 3.5v6L13 11v2l1.5 1.5v6"/><path d="M4.5 12h3M16.5 12h3"/>',
  'bed-plate': PLATE + '<path d="M3.5 17.5v2h13l4-12v-2"/>',
  'textured-plate': PLATE + '<path d="M10 9h.01M13.5 9h.01M17 9h.01M7.5 14h.01M11 14h.01M14.5 14h.01"/>',
  'smooth-plate': PLATE + '<path d="M9 14.5l2-6"/>',
  'engineering-plate': PLATE + '<path d="M5.5 11.5h13M12 5.5l-4 12M16 5.5l-4 12"/>',
  'glass-plate': '<path d="M7.5 5.5h13l-4 12h-13z"/><path d="M5.5 8.5l-3 9.5h13"/><path d="M15 8l-1.5 4.5"/>',
  magnet: '<path d="M5 3.5v8a7 7 0 0 0 14 0v-8"/><path d="M9.5 3.5v8a2.5 2.5 0 0 0 5 0v-8"/><path d="M5 3.5h4.5M14.5 3.5H19M5 7.5h4.5M14.5 7.5H19"/>',
  clip: '<path d="M15.5 7v9.5a3.5 3.5 0 0 1-7 0V6a2.5 2.5 0 0 1 5 0v9.5a1 1 0 0 1-2 0V7"/>',
  chamber: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M9 16c-1-1-1-2 0-3s1-2 0-3M12 16c-1-1-1-2 0-3s1-2 0-3M15 16c-1-1-1-2 0-3s1-2 0-3"/>',
  'chamber-temp': '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M10.5 12V7.5a1.5 1.5 0 0 1 3 0V12a3 3 0 1 1-3 0z"/><path d="M12 12.5v2"/>',
  enclosure: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M12 3.5v17M9.5 11v2M14.5 11v2"/>',
  led: '<path d="M8.5 13V9.5a3.5 3.5 0 0 1 7 0V13"/><path d="M7 13h10M10 13v7.5M14 13v5.5"/><path d="M3.5 9.5H5M19 9.5h1.5M5.5 4.5l1.2 1.2M18.5 4.5l-1.2 1.2"/>',
  'ams-unit': '<rect x="2.5" y="6.5" width="19" height="12" rx="2"/><path d="M2.5 10h19M7.25 10v8.5M12 10v8.5M16.75 10v8.5"/>',
  'ams-slot': '<rect x="6.5" y="3.5" width="11" height="17" rx="2"/><path d="M12 7.5v7M9.5 12l2.5 2.5 2.5-2.5"/><path d="M9.5 17.5h5"/>',
  'ams-empty': '<rect x="6.5" y="3.5" width="11" height="17" rx="2"/><circle cx="12" cy="12" r="3.5" stroke-dasharray="1.8 1.9"/>',
  'ams-loaded': '<rect x="6.5" y="3.5" width="11" height="17" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 12h.01"/>',
  // Calibration
  'flow-calibration': '<path d="M8.5 5c2.5 3 4 5.3 4 7.5a4 4 0 0 1-8 0c0-2.2 1.5-4.5 4-7.5z"/><path d="M17 4v16M17 6h3M17 10h2M17 14h3M17 18h2"/>',
  'pressure-advance': '<path d="M4.5 4v16"/><path d="M19.5 4.5L10 12l9.5 7.5M19.5 9L15.5 12l4 3"/>',
  'temp-tower': '<rect x="4.5" y="3.5" width="8" height="17" rx="1"/><path d="M4.5 9h8M4.5 15h8"/><path d="M16 13.5V5a1.5 1.5 0 0 1 3 0v8.5a3 3 0 1 1-3 0z"/>',
  'retraction-test': '<path d="M3.5 20.5h17"/><path d="M5.5 20.5V8h4v12.5M14.5 20.5V8h4v12.5"/><path d="M9.5 11c1.5 1.5 3.5 1.5 5 0M9.5 15c1.5 1 3.5 1 5 0"/>',
  'bed-level': '<rect x="3.5" y="7.5" width="17" height="6" rx="3"/><path d="M10 7.5v6M14 7.5v6"/>' + DOT(12, 10.5) + '<path d="M3.5 18h17"/>',
  'mesh-level': '<path d="M4 8c2.7-1.5 5.3-1.5 8 0s5.3 1.5 8 0M4 12c2.7-1.5 5.3-1.5 8 0s5.3 1.5 8 0M4 16c2.7-1.5 5.3-1.5 8 0s5.3 1.5 8 0"/><path d="M4 8v8M12 8v8M20 8v8"/>',
  'z-offset': '<path d="M8 3.5h8l-2.5 5h-3z"/><path d="M12 11.5v5M10.5 13l1.5-1.5 1.5 1.5M10.5 15l1.5 1.5 1.5-1.5"/><path d="M3.5 19.5h17"/>',
  'first-layer': '<path d="M3.5 20h17"/><path d="M5.5 16.5h13V13h-13V9.5h13"/>',
  vibration: '<rect x="8.5" y="4.5" width="7" height="15" rx="1.5"/><path d="M5.5 8.5v7M18.5 8.5v7M3 10.5v3M21 10.5v3"/>',
  'input-shaper': '<path d="M3.5 3.5v17h17"/><path d="M6.5 12c1-6.5 2.5-6.5 3.5 0s2.5 4.5 3.5 0 2.5-3 3.5 0 2-1.5 3 0"/>',
  'max-flow': '<path d="M6 3.5h12"/><path d="M12 10V6M9.5 8.5L12 6l2.5 2.5"/><path d="M12 12c2 2.4 3 3.8 3 5a3 3 0 0 1-6 0c0-1.2 1-2.6 3-5z"/>',
  tolerance: '<path d="M3.5 9h5.5v11H3.5M20.5 9H15v11h5.5"/><path d="M9 5h6M10.5 3.5L9 5l1.5 1.5M13.5 3.5L15 5l-1.5 1.5"/>',
  // Sensors
  sensor: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a10 10 0 0 0 0 13M18.5 5.5a10 10 0 0 1 0 13"/>',
  'filament-sensor': '<rect x="6.5" y="8" width="10" height="8" rx="1.5"/><path d="M11.5 3v5M11.5 16v5"/><path d="M11.5 12h.01"/><path d="M19 9.5a3.5 3.5 0 0 1 0 5"/>',
  'door-sensor': '<path d="M4.5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h5.5A1.5 1.5 0 0 1 13 5v15.5M3 20.5h11.5"/><path d="M10.5 12.5h.01"/><path d="M16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a8 8 0 0 1 0 10"/>',
  'camera-off': '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7L10 4.5h4L15.5 7"/>' + SLASH,
  timelapse: '<path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5"/><path d="M3.5 12A8.5 8.5 0 0 1 12 3.5" stroke-dasharray="0 3.3"/><path d="M10.5 9v6l4.5-3z"/>',
  snapshot: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 17l5-5 4.5 4.5M12 15l2.5-2.5 6 6"/><circle cx="15.5" cy="8.5" r="1.5"/>',
  spaghetti: '<path d="M3.5 20.5h17"/><path d="M4.5 16.5c3-6 6-1 9-5s4 1 7 0"/><path d="M6.5 11.5c2-4 6 2 9-2"/><path d="M8.5 8c1-3 4-2 5-4"/><path d="M13 17.5c2 0 3-2 4.5-1.5"/>',
  detection: FRAME_CORNERS + '<path d="M6.5 12c1.4-2.3 3.3-3.5 5.5-3.5s4.1 1.2 5.5 3.5c-1.4 2.3-3.3 3.5-5.5 3.5S7.9 14.3 6.5 12z"/>' + DOT(12, 12),
  'alert-bell': '<path d="M6 15.5v-5a6 6 0 0 1 12 0v5l1.5 1.5h-15z"/><path d="M10 19.5a2 2 0 0 0 4 0"/><path d="M3 8.5a9.5 9.5 0 0 1 2.5-5M21 8.5a9.5 9.5 0 0 0-2.5-5"/>',
  'bell-off': BELL + SLASH,
  notification: '<path d="M5 15.5V10a6 6 0 0 1 9-5.2"/><path d="M17 9v6.5l1.5 1.5h-15L5 15.5"/><path d="M10 19.5a2 2 0 0 0 4 0"/><circle cx="18.5" cy="5" r="2.5"/>',
  // Devices and cloud
  cloud: CLOUD,
  'cloud-off': CLOUD + SLASH,
  'cloud-upload': CLOUD + '<path d="M12 16v-5M9.5 13.5L12 11l2.5 2.5"/>',
  'cloud-download': CLOUD + '<path d="M12 10.5v5M9.5 13L12 15.5l2.5-2.5"/>',
  sync: '<path d="M4.5 10a7.5 7.5 0 0 1 13.8-2.5M19.5 14a7.5 7.5 0 0 1-13.8 2.5"/><path d="M18.5 3.5v4h-4M5.5 20.5v-4h4"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 5.5h3M11 18.5h2"/>',
  tablet: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 18h2"/>',
  desktop: '<rect x="2.5" y="3.5" width="19" height="13" rx="1.5"/><path d="M12 16.5v4M8 20.5h8"/>',
  laptop: '<rect x="4.5" y="4.5" width="15" height="11" rx="1.5"/><path d="M2.5 19h19"/>',
  qr: '<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><path d="M14.5 14.5h.01M17.5 17.5h.01M20.5 20.5h.01M14.5 20.5h.01M20.5 14.5h.01"/>',
  link: '<rect x="2.5" y="9.5" width="11" height="5" rx="2.5" transform="rotate(-45 12 12)"/><rect x="10.5" y="9.5" width="11" height="5" rx="2.5" transform="rotate(-45 12 12)"/>',
  unlink: '<rect x="2.5" y="9.5" width="8" height="5" rx="2.5" transform="rotate(-45 12 12)"/><rect x="13.5" y="9.5" width="8" height="5" rx="2.5" transform="rotate(-45 12 12)"/><path d="M8 4v2M4 8h2M16 20v-2M20 16h-2"/>',
  wifi: '<path d="M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 14 0M2.5 9a14.5 14.5 0 0 1 19 0"/><path d="M12 19.5v.01"/>',
  ethernet: '<path d="M4.5 20.5v-11h3v-3h9v3h3v11z"/><path d="M9 13v3M12 13v3M15 13v3"/>',
  usb: '<rect x="8.5" y="3" width="7" height="5" rx=".5"/><path d="M10.75 5.5h.01M13.25 5.5h.01"/><path d="M6.5 8h11v6.5a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2z"/><path d="M12 16.5V21"/>',
  'sd-card': '<path d="M9 3.5h7.5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V7z"/><path d="M10 7v2.5M12.5 7v2.5M15 7v2.5"/>',
  bluetooth: '<path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9"/>',
  // Integrations
  mcp: '<rect x="8.5" y="8.5" width="7" height="7" rx="1.5"/><path d="M12 8.5V5.5M12 15.5v3M8.5 12h-3M15.5 12h3"/>' + DOT(12, 4) + DOT(12, 20) + DOT(4, 12) + DOT(20, 12),
  server: '<rect x="3.5" y="3.5" width="17" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="7" rx="1.5"/><path d="M7 7h.01M10 7h.01M7 17h.01M10 17h.01"/>',
  api: '<path d="M8.5 4h-1a2 2 0 0 0-2 2v3.5L3.5 12l2 2.5V18a2 2 0 0 0 2 2h1"/><path d="M15.5 4h1a2 2 0 0 1 2 2v3.5l2 2.5-2 2.5V18a2 2 0 0 1-2 2h-1"/><path d="M9.5 12h.01M12 12h.01M14.5 12h.01"/>',
  'plugin-slot': '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M9.5 9v3.5M14.5 9v3.5M10 16.5h4"/>',
  webhook: '<circle cx="12" cy="6.5" r="2.5"/><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M10.75 8.7L7.25 14.8M13.25 8.7l3.5 6.1M8.5 17h7"/>',
  key: '<circle cx="7.5" cy="12" r="4"/><path d="M11.5 12h9M17.5 12v3M20.5 12v2.5"/>',
  token: '<rect x="2.5" y="7.5" width="19" height="9" rx="4.5"/><path d="M7 12h.01M10.3 12h.01M13.7 12h.01M17 12h.01"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5v-3a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5v-3a4 4 0 0 1 7.7-1.5"/><path d="M12 14.5v2"/>',
  permission: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 9.5-4.9"/><rect x="14" y="14.5" width="7" height="6" rx="1"/><path d="M15.75 14.5V13a1.75 1.75 0 0 1 3.5 0v1.5"/>',
  'approval-required': '<circle cx="12" cy="12" r="8.5" stroke-dasharray="2.2 2.25"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  // Actions
  undo: '<path d="M9 14.5L4.5 10 9 5.5"/><path d="M4.5 10h10a5 5 0 0 1 0 10H11"/>',
  redo: '<path d="M15 14.5l4.5-4.5L15 5.5"/><path d="M19.5 10h-10a5 5 0 0 0 0 10H13"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  paste: '<path d="M9 4.5H7.5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-12a2 2 0 0 0-2-2H15"/><rect x="9" y="3" width="6" height="3.5" rx="1"/>',
  duplicate: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/><path d="M14.5 12v5M12 14.5h5"/>',
  delete: '<path d="M4 6.5h16"/><path d="M9.5 6.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/><path d="M6 6.5l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 6.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  rename: '<path d="M13 7H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h8M19 7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2"/><path d="M16 4.5v15M14 4.5h4M14 19.5h4"/><path d="M6.5 12h3.5"/>',
  import: '<path d="M10 4.5h8.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H10"/><path d="M3.5 12h11M11 8.5l3.5 3.5-3.5 3.5"/>',
  export: '<path d="M14 4.5H5.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14"/><path d="M9.5 12h11M17 8.5l3.5 3.5-3.5 3.5"/>',
  open: '<path d="M3.5 18.5v-13a1 1 0 0 1 1-1h5l2 2.5h6.5a1 1 0 0 1 1 1v2.5"/><path d="M3.5 18.5L6 10.5h14.5l-2.5 8z"/>',
  save: '<path d="M5 3.5h11.5l4 4V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M7.5 20.5v-6h9v6M8 3.5v4h7v-4"/>',
  settings: `<path d="${GEAR}"/><circle cx="12" cy="12" r="3"/>`,
  'settings-reset': '<path d="M4 12a8 8 0 1 0 2.35-5.65"/><path d="M4 3.5V8h4.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 7.5v1.5M12 15v1.5M7.5 12H9M15 12h1.5"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.35-5.65"/><path d="M4 3.5V8h4.5"/><path d="M12 8v4l3 2"/>',
  star: `<path d="${STAR}"/>`,
  'star-off': `<path d="${STAR}"/>` + SLASH,
  tag: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h10l5.5 6-5.5 6H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M15 12h.01"/>',
  pin: '<path d="M8.5 3.5h7M10 3.5v5l-3 4h10l-3-4v-5M12 12.5v8"/>',
  share: '<path d="M8 8.5H6.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-10a1 1 0 0 0-1-1H16"/><path d="M12 3v11M8.5 6.5L12 3l3.5 3.5"/>',
  comment: '<path d="M4 5.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4.5 4v-4H6a2 2 0 0 1-2-2z"/>',
  // Interface
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9-.7c.4 1.5-.9 2.2-1.6 2.7-.5.4-.8.8-.8 1.5v.5"/><path d="M12 16.5v.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.01"/>',
  warning: '<path d="M8.5 3.5h7l5 5v7l-5 5h-7l-5-5v-7z"/><path d="M12 8v5M12 16v.01"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  minus: '<path d="M5 12h14"/>',
  'chevron-up': '<path d="M6.5 14.5L12 9l5.5 5.5"/>',
  'chevron-left': '<path d="M14.5 6.5L9 12l5.5 5.5"/>',
  'chevron-right': '<path d="M9.5 6.5L15 12l-5.5 5.5"/>',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  external: '<path d="M13.5 3.5h7v7M20.5 3.5l-9 9"/><path d="M18 14v4.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-3.5"/><path d="M4 13a8 8 0 0 0 14.5 3.5"/><path d="M4.5 4.5v4h4M19.5 19.5v-4h-4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  skip: '<path d="M6 5.5v13l9-6.5z"/><path d="M18 5.5v13"/>',
  record: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.5"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  'volume-off': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M12 8h5M12 12h6M12 16h5"/>',
  language: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c-2.5 2.5-3.5 5.5-3.5 8.5s1 6 3.5 8.5c2.5-2.5 3.5-5.5 3.5-8.5s-1-6-3.5-8.5z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14.5h8"/>',
  mouse: '<rect x="6.5" y="3" width="11" height="18" rx="5.5"/><path d="M12 7v3"/>',
  log: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5"/><path d="M8.5 12h7M8.5 15h7M8.5 18h4"/>',
  bug: '<rect x="7.5" y="7.5" width="9" height="13" rx="4.5"/><path d="M9.5 7.5a2.5 2.5 0 0 1 5 0"/><path d="M12 11v9.5"/><path d="M4 10.5h3.5M16.5 10.5H20M3.5 15h4M16.5 15h4M4.5 20l3.2-2M19.5 20l-3.2-2M9.5 4l1 1.5M14.5 4l-1 1.5"/>',
  sparkle: '<path d="M10 7.5c.5 3.6 2.9 6 6.5 6.5-3.6.5-6 2.9-6.5 6.5-.5-3.6-2.9-6-6.5-6.5 3.6-.5 6-2.9 6.5-6.5z"/><path d="M17.5 3.5c.3 1.6 1.4 2.7 3 3-1.6.3-2.7 1.4-3 3-.3-1.6-1.4-2.7-3-3 1.6-.3 2.7-1.4 3-3z"/>',
  'magic-wand': '<path d="M3.5 20.5l11-11M14.5 9.5l2-2"/><path d="M17 2.5v3M15.5 4h3M20 9.5v2M19 10.5h2M9 4.5v2M8 5.5h2"/>',
  // Views
  fullscreen: '<path d="M3.5 8.5v-5h5M15.5 3.5h5v5M20.5 15.5v5h-5M8.5 20.5h-5v-5"/>',
  'exit-fullscreen': '<path d="M8.5 3.5v5h-5M20.5 8.5h-5v-5M15.5 20.5v-5h5M3.5 15.5h5v5"/>',
  'zoom-in': SEARCH + '<path d="M11 8.5v5M8.5 11h5"/>',
  'zoom-out': SEARCH + '<path d="M8.5 11h5"/>',
  fit: FRAME_CORNERS + '<rect x="8.5" y="8.5" width="7" height="7" rx="1"/>',
  'home-view': '<path d="M3.5 11L12 3.5l8.5 7.5"/><path d="M6 9v11.5h12V9"/><path d="M10 20.5v-5h4v5"/>',
  'top-view': CUBE + `<path d="${inset(FACE_TOP, 0.45)}"/>`,
  'front-view': CUBE + `<path d="${inset(FACE_LEFT, 0.45)}"/>`,
  'side-view': CUBE + `<path d="${inset(FACE_RIGHT, 0.45)}"/>`,
  'iso-view': CUBE + DOT(12, 7.25) + DOT(8.25, 13.9) + DOT(15.75, 13.9),
  wireframe: '<rect x="3.5" y="8.5" width="12" height="12" rx=".5"/><rect x="8.5" y="3.5" width="12" height="12" rx=".5"/><path d="M3.5 8.5l5-5M15.5 8.5l5-5M15.5 20.5l5-5M3.5 20.5l5-5"/>',
  'x-ray': '<rect x="3.5" y="3.5" width="17" height="17" rx="3" stroke-dasharray="2 2.6"/><path d="M12 7.5l4 2.25v4.5L12 16.5l-4-2.25v-4.5z"/><path d="M8 9.75L12 12l4-2.25M12 12v4.5"/>',
  clay: '<circle cx="12" cy="10.5" r="7"/><path d="M15.5 10.5a3.5 3.5 0 0 1-3.5 3.5"/><path d="M6.5 20.5h11"/>',
  hide: EYE + '<path d="M4 4l16 16"/>',
  show: EYE,
  isolate: '<rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/><path d="M4 4h.01M20 4h.01M4 20h.01M20 20h.01"/>',
  // Slicing
  layers: '<rect x="3.5" y="4.5" width="17" height="4" rx="1.5"/><rect x="3.5" y="10" width="17" height="4" rx="1.5"/><rect x="3.5" y="15.5" width="17" height="4" rx="1.5"/>',
  toolpath: '<path d="M3.5 6h14a3 3 0 0 1 0 6h-11a3 3 0 0 0 0 6H20"/><path d="M17.5 15.5L20 18l-2.5 2.5"/>',
  travel: '<path d="M4.5 18.5c5 0 4-12.5 9-12.5H18" stroke-dasharray="2 2.5"/><path d="M15.5 3.5L18 6l-2.5 2.5"/>',
  retract: '<path d="M12 8.5v-5M9.5 6L12 3.5 14.5 6"/><rect x="6.5" y="10.5" width="11" height="4" rx="1.5"/><path d="M8.5 14.5h7l-2 4h-3z"/>',
  wipe: '<rect x="7.5" y="3.5" width="9" height="4" rx="1.5"/><path d="M9.5 7.5h5l-1.5 3.5h-2z"/><path d="M3.5 5.5h2M18.5 5.5h2"/><path d="M4.5 15h15M7 15v5M10.5 15v5M13.5 15v5M17 15v5"/>',
  'layer-time': '<path d="M3.5 6.5h13M3.5 11h8M3.5 15.5h5"/><circle cx="16" cy="15.5" r="4.5"/><path d="M16 13.5v2l1.5 1"/>',
  cooling: [0, 60, 120, 180, 240, 300].map((a) => `<path d="M12 12V3.5M9.5 4.5L12 7l2.5-2.5"${a ? ` transform="rotate(${a} 12 12)"` : ''}/>`).join(''),
  overhang: '<path d="M3.5 20.5h17"/><path d="M5.5 20.5v-16h13v5.5H11v10.5"/><path d="M15 13v5" stroke-dasharray="0 2.5"/>',
  bridge: '<path d="M4.5 20.5v-12h15v12"/><path d="M9 20.5V13h6v7.5"/><path d="M3 20.5h3M18 20.5h3"/>',
  'thin-wall': '<rect x="10.5" y="3.5" width="3" height="17" rx="1"/><path d="M3.5 12h4M5.5 10L7.5 12l-2 2M20.5 12h-4M18.5 10L16.5 12l2 2"/>',
  'gap-fill': '<path d="M5 3.5v17M19 3.5v17"/><path d="M8.5 6l7 3-7 3 7 3-7 3"/>',
  'elephant-foot': '<path d="M7.5 3.5h9v13c0 1.5 1.5 2.5 3 3.5h-15c1.5-1 3-2 3-3.5z"/>',
  'z-hop': '<path d="M3.5 19H8V9.5h8V19h4.5"/><path d="M11 7.5l2 2-2 2"/>',
  'purge-line': '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M7 17V8a1.25 1.25 0 0 1 2.5 0v9"/>',
  skirt: '<rect x="8.5" y="8.5" width="7" height="7" rx="1.5"/><path d="M10.5 20.5H6A2.5 2.5 0 0 1 3.5 18V6A2.5 2.5 0 0 1 6 3.5h12A2.5 2.5 0 0 1 20.5 6v12a2.5 2.5 0 0 1-2.5 2.5h-4.5"/>',
  raft: '<rect x="7.5" y="4.5" width="9" height="8" rx="1.5"/><rect x="3.5" y="15.5" width="17" height="5" rx="1"/><path d="M7.5 15.5v5M12 15.5v5M16.5 15.5v5"/>',
  'tree-support': '<path d="M4 4.5h16"/><path d="M12 20.5V14L8 9.5M12 14l4-4.5M8 9.5L5.5 4.5M8 9.5l2-5M16 9.5l2.5-5M16 9.5l-2-5M9.5 20.5h5"/>',
  'normal-support': '<rect x="4.5" y="3.5" width="15" height="4.5" rx="1.5"/><path d="M7 8v12.5M10.5 8v12.5M14 8v12.5M17.5 8v12.5"/>',
  'variable-layer': '<path d="M3.5 4h12M3.5 7h12M3.5 10.5h12M3.5 15h12M3.5 20.5h12"/><path d="M19.5 8v8M17.5 10l2-2 2 2M17.5 14l2 2 2-2"/>',
  // Plate tools
  'new-plate': '<path d="M7 12.5h10.5l-3 6.5H4z"/><path d="M18.5 3.5v6M15.5 6.5h6"/>',
  plate: '<path d="M7.5 7.5h13l-4 9h-13z"/>',
  plates: '<path d="M8 4.5h12.5L17 12H4.5z"/><path d="M6.6 12l-2.1 4.5H17l3.5-7.5h-2.1"/>',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M9 6.5L3.5 17.5H9zM15 6.5l5.5 11H15z"/>',
  'lay-flat': '<path d="M12 3.5v7M9 7.5l3 3 3-3"/><rect x="6.5" y="13.5" width="11" height="5" rx="1"/><path d="M3.5 20.5h17"/>',
  snap: '<rect x="12" y="12" width="7.5" height="7.5" rx="1"/><path d="M4.5 4.5h.01M12 4.5h.01M19.5 4.5h.01M4.5 12h.01M4.5 19.5h.01"/>',
  group: DASH_FRAME + '<rect x="7" y="7" width="5.5" height="5.5" rx="1"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1"/>',
  ungroup: '<rect x="3.5" y="3.5" width="8" height="8" rx="1.5"/><rect x="12.5" y="12.5" width="8" height="8" rx="1.5"/>',
  'select-all': DASH_FRAME + '<path d="M8 12.5l3 3 5-6"/>',
  deselect: DASH_FRAME + '<path d="M9 9l6 6M15 9l-6 6"/>',
  measure: '<path d="M3.5 7.5v9M20.5 7.5v9M6 12h12M8.5 9.5L6 12l2.5 2.5M15.5 9.5L18 12l-2.5 2.5"/>',
  ruler: '<rect x="3" y="8.5" width="18" height="7" rx="1.5" transform="rotate(-45 12 12)"/><path d="M7 8.5v3M10 8.5v2M13 8.5v3M16 8.5v2" transform="rotate(-45 12 12)"/>',
  split: '<path d="M12 3.5v17" stroke-dasharray="2 2.5"/><path d="M9 6.5H5.5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2H9M15 6.5h3.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H15"/>',
  merge: '<path d="M6 3.5V7c0 3 6 4 6 7.5v6M18 3.5V7c0 3-6 4-6 7.5"/><path d="M9 17.5l3 3 3-3"/>',
  hollow: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><rect x="7.5" y="7.5" width="9" height="9" rx="1.5" stroke-dasharray="2 2"/>',
  'drain-hole': '<path d="M10.5 17H6a2.5 2.5 0 0 1-2.5-2.5V6A2.5 2.5 0 0 1 6 3.5h12A2.5 2.5 0 0 1 20.5 6v8.5A2.5 2.5 0 0 1 18 17h-4.5"/><path d="M12 20v.01"/>',
  text: '<path d="M5 6.5v-2h14v2M12 4.5v15M9 19.5h6"/>',
  shapes: '<circle cx="7.5" cy="7.5" r="4"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5"/><path d="M12 13l4.5 7.5h-9z"/>',
  'push-pull': '<path d="M14.9 11.1c.2-4-1.4-6.9-4.1-6.9-2 0-3.4 1.3-3.6 3.1a1.3 1.3 0 0 0 2.6.3c.1-.5.6-.9 1.2-.9 1.3 0 1.9 1.7 1.6 4.1"/><path d="M11.4 14.6 8.4 9.3a1.8 1.8 0 0 0-3.2 1.8l3 5.3"/><path d="M14.9 11.1a2.3 2.3 0 0 1 4.6.7v2.7c0 3.6-2.9 6.5-6.5 6.5h-1c-1.4 0-2.6-.8-3.8-2.7l-.1-2"/>',
  'fillet-edge': '<path d="M4.5 3.5v8a9 9 0 0 0 9 9h7"/><path d="M4.5 16v4.5H9" stroke-dasharray="1.6 2.2"/>',
  'hole-fit': '<ellipse cx="12" cy="8.5" rx="8.5" ry="4"/><path d="M3.5 8.5v7c0 2.2 3.8 4 8.5 4s8.5-1.8 8.5-4v-7"/><ellipse cx="12" cy="8.5" rx="4.5" ry="2"/><path d="M10 9.6v2.2c0 .6.9 1 2 1s2-.4 2-1V9.6"/>',
  'thread-bolt': '<path d="M7 3.5h10v4H7z"/><path d="M9 7.5v13h6v-13"/><path d="M9 11l6-1.5M9 14.5l6-1.5M9 18l6-1.5"/>',
  'on-face': '<path d="M2.5 16 8 11h13.5L16 16z"/><ellipse cx="12" cy="13.5" rx="3" ry="1.2"/><path d="M9 13.5V7.2c0-.7 1.3-1.2 3-1.2s3 .5 3 1.2v6.3"/><path d="M9 7.2c0 .7 1.3 1.2 3 1.2s3-.5 3-1.2"/>',
  'svg-face': '<path d="M2.5 17 8 12h13.5L16 17z"/><path d="M7 8.5C8.5 4.5 15.5 4.5 17 8.5"/><rect x="5.8" y="7.8" width="2.4" height="2.4" rx=".4"/><rect x="15.8" y="7.8" width="2.4" height="2.4" rx=".4"/>',
  'shell-open': '<path d="M4 5.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5.5"/><path d="M7.5 5.5v11h9v-11"/><path d="M4 5.5h3.5M16.5 5.5H20"/>',
  'subtract-shape': '<rect x="3.5" y="3.5" width="11" height="11" rx="2"/><path d="M14.5 9.5h4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-4" stroke-dasharray="2 2"/><path d="M6.5 9h5"/>',
  'named-values': '<path d="M4 8l5.5 8M9.5 8 4 16"/><path d="M13.5 10.5h7M13.5 14h7"/>',
  // fewer facets: the outline split once
  'simplify-mesh': '<path d="M3.5 19 12 4.5 20.5 19z"/><path d="M12 4.5V19"/>',
  sphere: '<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="8.5" ry="3"/>',
  cube: CUBE,
  cylinder: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/>',
  cone: '<path d="M5 17.5L12 3.5l7 14"/><ellipse cx="12" cy="17.5" rx="7" ry="2.5"/>',
  'support-painting': '<path d="M3.5 4h9M5.5 4v7.5M10.5 4v7.5"/>' + PENCIL,
  'seam-painting': '<path d="M11.5 8a4 4 0 1 1-4-4"/>' + DOT(9.9, 4.8) + PENCIL,
  'preset-draft': '<rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M4 12h16" stroke-width="2.5"/>',
  'preset-standard': '<rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M4 7.75h16M4 12h16M4 16.25h16"/>',
  'preset-fine': '<rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M4 5.65h16M4 7.75h16M4 9.9h16M4 12h16M4 14.1h16M4 16.25h16M4 18.35h16" stroke-width="0.75"/>',
  'preset-strong': '<rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M4 9.25h16M4 14.75h16M9.25 3.5v17M14.75 3.5v17"/>',
  'color-painting': '<path d="M7.5 3.5c2 2.5 3.5 4.3 3.5 6a3.5 3.5 0 0 1-7 0c0-1.7 1.5-3.5 3.5-6z"/>' + PENCIL,
  // Named features (design/NAMES.md), the marks picked from the brand canvas icon sheets.
  // slicerx is the brand X as offset perimeters: one wall around a solid core.
  slicerx: '<path d="M3.4 3h7.2L12 5.55 13.4 3h7.2l-5 9 5 9h-7.2L12 18.45 10.6 21H3.4l5-9z"/><path d="M6.6 4.9h2.9L12 9.45l2.5-4.55h2.9l-4 7.1 4 7.1h-2.9L12 14.55l-2.5 4.55H6.6l4-7.1z" fill="currentColor" stroke="none"/>',
  // slicerx-mark is the app icon in line form: huginn perched on three printed layers.
  'slicerx-mark': '<path d="M1.6 5.58C2.42 4.31 3.72 3.56 5.01 3.54C5.71 2.71 6.8 2.24 8.21 2.24C9.62 2.24 10.65 2.9 11.26 4.03C12.06 5.21 13.33 6.01 14.69 6.9C16.05 7.77 17.23 9.29 17.98 10.99L19.72 14.56C19.91 14.84 19.86 15.17 19.58 15.31L19.2 15.5C19.02 15.59 18.78 15.55 18.64 15.4L16.64 14.09C15.59 13.48 14.64 13.29 13.47 13.2L10.88 13.2C8.65 13.1 7.03 11.93 6.37 10C6.23 9.53 6.14 9.06 6.04 8.5C5.81 7.56 5.48 6.71 5.1 6.1C3.83 6.01 2.66 5.86 1.81 5.75z"/><path d="M9.47 6.12C11.12 8.59 13.94 10.71 17.98 12.35"/><circle cx="7.12" cy="4.27" r="0.85" fill="currentColor" stroke="none"/><path d="M8.4 16.4h6.8M7.4 19.1h8.8M6.4 21.8h10.8"/>',
  // mimir is the Mannaz rune over one filament bead.
  mimir: '<path d="M6 3v18M18 3v18"/><path d="M6 3l12 8M18 3L6 11"/><circle cx="12" cy="17" r="1.6" fill="currentColor" stroke="none"/>',
  // aegis is a shield of two walls, outer and inner perimeter.
  aegis: '<path d="M12 2.5l7.5 3v6c0 4.6-3.2 8.3-7.5 10-4.3-1.7-7.5-5.4-7.5-10v-6z"/><path d="M12 6.4l4.2 1.7v3.5c0 2.7-1.7 4.9-4.2 6-2.5-1.1-4.2-3.3-4.2-6V8.1z"/>',
  // sleipnir is a horse head with thin layers on the curve and a thick one below.
  sleipnir: '<path d="M4.5 14.5L3.5 11C4.5 8.5 6.5 6.5 9 5.5l1.5-3 1.5 3c4.5.5 8 4 8.5 9.5V21H10v-4C8.5 16.8 6.5 16 4.5 14.5z"/><path d="M12 9h4M12 11.5h6M12 18h8"/>',
  // atlas is the prime tower striped by color changes, on the plate.
  atlas: '<path d="M8 3.5h8v15.5H8z"/><path d="M8 7.5h8M8 11.5h8M8 15.5h8"/><path d="M4.5 21.5h15"/>',
  // huginn is Odin's raven of thought on a perch: heavy beak, shaggy throat, wing over a wedge tail.
  huginn: '<path d="M2 9.6L8.2 5.8C9.6 5 11 5.3 12 6.3l3.6 3.7c1.6 1.6 3.8 3.1 6.4 4.4l-1 1.6-4.6-.7c-1.8 2.6-6.4 3.1-8.4.3-.6-.9-.9-1.9-1.1-3l-.8-.3.6-.8-.7-.3.4-.8z"/><path d="M10.6 9.8c2.8 1 5.4 3.2 7.2 6.4"/><circle cx="9.4" cy="7.6" r="0.85" fill="currentColor" stroke="none"/><path d="M11 18.3v2.2M13.8 17.9v2.6M8 20.5h8.5"/>',
  // muninn, the raven of memory, flies the other way: wing raised, primaries spread, wedge tail.
  muninn: '<path d="M22.5 12l-5.9 -3.4c-1.3 -0.7 -2.8 -0.6 -3.9 0.2 -2.1 1.3 -4.5 2 -6.7 2.3l-4.5 -1.3 0.8 3.2 3.9 0.5c2 2 6.1 2.6 8.6 0.8 0.4 -0.3 0.8 -0.7 1.1 -1.1l0.8 -0.1 -0.4 -0.6z"/><path d="M13 9.1C12.4 5.6 9.8 2.6 4.5 1.5l0.7 1.8 -1.6 -0.3 1 1.9 -1.3 0.1 1.6 2.2c1 1.4 2.4 2.8 4 3.9"/><circle cx="15.1" cy="10.5" r="0.85" fill="currentColor" stroke="none"/>',
  // strike is heimdall's collision mark: the slicerx X drawn as two offset perimeters per stroke, cracked where it lands.
  strike: '<path d="M4.3 5.95L9.8 11.45M13.65 14.2L18.05 19.15M5.95 4.3L11.45 9.8M14.2 13.65L19.15 18.05"/><path d="M18.05 4.3L13.65 9.25M9.8 13.65L4.3 18.6M19.7 5.95L14.75 10.35M10.35 14.75L5.95 19.7"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
}

export const EXTRA_ICON_GROUPS = {
  Materials: ['pla', 'petg', 'abs', 'asa', 'tpu', 'nylon', 'resin', 'carbon-fiber', 'silk', 'matte', 'glow', 'wood', 'spool-empty', 'spool-low', 'dry-box', 'humidity', 'filament-runout', 'filament-change', 'purge', 'flush'],
  Hardware: ['hotend', 'extruder', 'direct-drive', 'bowden', 'heatbreak', 'bed-plate', 'textured-plate', 'smooth-plate', 'engineering-plate', 'glass-plate', 'magnet', 'clip', 'chamber', 'chamber-temp', 'enclosure', 'led', 'ams-unit', 'ams-slot', 'ams-empty', 'ams-loaded'],
  Calibration: ['flow-calibration', 'pressure-advance', 'temp-tower', 'retraction-test', 'bed-level', 'mesh-level', 'z-offset', 'first-layer', 'vibration', 'input-shaper', 'max-flow', 'tolerance'],
  Sensors: ['sensor', 'filament-sensor', 'door-sensor', 'camera-off', 'timelapse', 'snapshot', 'spaghetti', 'detection', 'alert-bell', 'bell-off', 'notification'],
  'Devices and cloud': ['cloud', 'cloud-off', 'cloud-upload', 'cloud-download', 'sync', 'phone', 'tablet', 'desktop', 'laptop', 'qr', 'link', 'unlink', 'wifi', 'ethernet', 'usb', 'sd-card', 'bluetooth'],
  Integrations: ['mcp', 'server', 'api', 'plugin-slot', 'webhook', 'key', 'token', 'shield', 'lock', 'unlock', 'permission', 'approval-required'],
  Slicing: ['preset-draft', 'preset-standard', 'preset-fine', 'preset-strong', 'layers', 'toolpath', 'travel', 'retract', 'wipe', 'layer-time', 'cooling', 'overhang', 'bridge', 'thin-wall', 'gap-fill', 'elephant-foot', 'z-hop', 'purge-line', 'skirt', 'raft', 'tree-support', 'normal-support', 'variable-layer'],
  'Plate tools': ['new-plate', 'plate', 'plates', 'mirror', 'lay-flat', 'snap', 'group', 'ungroup', 'select-all', 'deselect', 'measure', 'ruler', 'split', 'merge', 'hollow', 'drain-hole', 'text', 'shapes', 'sphere', 'cube', 'cylinder', 'cone', 'support-painting', 'seam-painting', 'color-painting', 'push-pull', 'fillet-edge', 'hole-fit', 'thread-bolt', 'on-face', 'svg-face', 'shell-open', 'subtract-shape', 'named-values', 'simplify-mesh'],
  Views: ['fullscreen', 'exit-fullscreen', 'zoom-in', 'zoom-out', 'fit', 'home-view', 'top-view', 'front-view', 'side-view', 'iso-view', 'wireframe', 'x-ray', 'clay', 'hide', 'show', 'isolate'],
  Actions: ['undo', 'redo', 'copy', 'paste', 'duplicate', 'delete', 'rename', 'import', 'export', 'open', 'save', 'settings', 'settings-reset', 'history', 'star', 'star-off', 'tag', 'pin', 'share', 'comment'],
  Interface: ['help', 'info', 'warning', 'close', 'minus', 'chevron-up', 'chevron-left', 'chevron-right', 'arrow-up', 'arrow-down', 'arrow-left', 'arrow-right', 'external', 'refresh', 'stop', 'skip', 'record', 'volume', 'volume-off', 'sun', 'moon', 'contrast', 'language', 'keyboard', 'mouse', 'log', 'bug', 'sparkle', 'magic-wand'],
  'Named features': ['slicerx', 'slicerx-mark', 'mimir', 'aegis', 'sleipnir', 'atlas', 'huginn', 'muninn', 'strike'],
}
