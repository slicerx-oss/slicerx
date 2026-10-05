// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer hardware, filament, plates, connections, controls and community icons. Same contract as
// icons/extra.mjs: a 24px grid, drawn for stroke 1.75 with round caps and joins, no fill except
// tiny dots and the filled mouse button, currentColor. scripts/gen-icons.mjs merges this file after
// icons/extra.mjs.

// Three rotor blades around (cx, cy), the fan blade from base.mjs scaled by k.
const blades = (cx, cy, k) => {
  const pts = [[13.2, 10.6], [14.2, 7], [13.6, 3.8], [11.5, 3.6], [9, 3.4], [9.3, 7.4], [10.8, 10.3]]
  return [0, 120, 240].map((deg) => {
    const a = (deg * Math.PI) / 180
    const [p0, c1, c2, p1, c3, c4, p2] = pts.map(([x, y]) => {
      const dx = (x - 12) * k
      const dy = (y - 12) * k
      return `${r(cx + dx * Math.cos(a) - dy * Math.sin(a))} ${r(cy + dx * Math.sin(a) + dy * Math.cos(a))}`
    })
    return `M${p0}C${c1} ${c2} ${p1} ${c3} ${c4} ${p2}`
  }).join('')
}

const r = (v) => String(Math.round(v * 100) / 100)
const dot = (x, y) => `M${r(x)} ${r(y)}h.01`
const PLATE = '<path d="M7.5 5.5h13l-4 12h-13z"/>'
const SHIELD = '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/>'
const FILE = '<path d="M6.5 3.5h7l4.5 4.5v12.5h-11.5z"/>'
const FILE_FOLD = '<path d="M13.5 3.5V8H18"/>'
const CLOUD_S = '<path d="M10 10.5a3 3 0 0 1-.4-5.9 4 4 0 0 1 7.6.6 2.75 2.75 0 0 1 .3 5.3z"/>'
const HEART_S = (y) => `<path d="M12 ${y + 8}s-4.5-2.6-4.5-5.8A2.5 2.5 0 0 1 12 ${y + .6}a2.5 2.5 0 0 1 4.5 1.6c0 3.2-4.5 5.8-4.5 5.8z"/>`

// One nozzle silhouette for every size: a nut and a cone. The sizes differ only by the orifice under
// the tip, a bead that grows from a dot (0.2 mm) to a wide ring (1.0 mm). The closed cone has no orifice.
const NUT = '<rect x="4.5" y="3.5" width="15" height="4" rx="1.5"/>'
const CONE_OPEN = '<path d="M6 7.5l4.25 8M18 7.5l-4.25 8"/>'
const CONE_CLOSED = '<path d="M6 7.5l4 8.5h4l4-8.5"/>'
const NOZ = (orifice) => NUT + CONE_OPEN + `<circle cx="12" cy="19" r="${orifice}"/>`

// Open frame: two posts and a top rail, a cross gantry and a bed, drawn without side panels.
const FRAME = '<path d="M4.5 20.5V4.5h15v16"/><path d="M4.5 9h15"/>'
const HEAD = (x) => `<path d="M${x - 1.5} 9h3l-.75 3h-1.5z"/>`
// Printer with a cut corner, so a status badge sits in the lower right.
const PRINTER_BADGED = '<path d="M11.5 17.5H5.5a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2h9.5a2 2 0 0 1 2 2V11"/><path d="M3.5 8h13.5M7.5 8v3h4V8M6.5 14.5h4"/><circle cx="17.5" cy="17.5" r="3.5"/>'
const SPOOL = (cx, cy, rad, hub = 1.8) => `<circle cx="${cx}" cy="${cy}" r="${rad}"/><circle cx="${cx}" cy="${cy}" r="${hub}"/>`
const MOUSE = '<rect x="6.5" y="2.5" width="11" height="19" rx="5.5"/>'
const PAD = '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/>'
const LOOK = '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 8h17"/>'

export const HARDWARE_ICONS = {
  // Printers
  'printer-bed-slinger': '<path d="M7.5 13V4h9v9"/><path d="M10.5 7h3l-.75 3h-1.5z"/><path d="M6.5 13.5h14.5l-3 4.5H3.5z"/><path d="M7 21.5h10M9 20l-2 1.5L9 23M15 20l2 1.5-2 1.5"/>',
  'printer-corexy-open': FRAME + '<path d="M4.5 8.5l3-4M19.5 8.5l-3-4"/>' + HEAD(12) + '<path d="M8 17h8"/>',
  'printer-corexy-enclosed': '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 8h17M14.5 8v12.5"/><path d="M12.5 12.5v3"/><path d="M6.5 11.5h3l-.75 3h-1.5z"/>',
  'printer-cartesian-gantry': '<path d="M6 4v13M18 4v13"/><path d="M3.5 8.5h17"/>' + HEAD(12).replace('9h3', '8.5h3').replace('M10.5 9', 'M10.5 8.5') + '<rect x="3.5" y="17" width="17" height="3.5" rx="1"/>',
  'printer-delta': '<path d="M5 3.5v17M19 3.5v17"/><path d="M3.5 8h3M17.5 8h3"/><path d="M5 8l6.5 6M19 8l-6.5 6"/><path d="M10.5 14.5h3l-.75 2h-1.5z"/><ellipse cx="12" cy="19.5" rx="5.5" ry="1.5"/>',
  'printer-idex': FRAME + '<path d="M6.5 9h4l-.75 3h-2.5zM13.5 9h4l-.75 3h-2.5z"/><path d="M9 12v1.5M15 12v1.5"/><path d="M8 17.5h8"/>',
  'printer-toolchanger': '<path d="M3.5 4.5h17"/><path d="M7 4.5v2.5M15 4.5v6.5"/><path d="M5 7h4l-.75 3h-2.5zM13 11h4l-.75 3h-2.5z"/><path d="M6 19h12"/>',
  'printer-resin': '<path d="M5 13.5h14v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M12 3.5V8M8.5 8h7"/><path d="M9 17h6"/>',
  'printer-custom': '<path d="M11.5 17.5H5.5a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2h9.5a2 2 0 0 1 2 2V11"/><path d="M3.5 8h13.5M7.5 8v3h4V8M6.5 14.5h4"/><path d="M17.5 14v7M14 17.5h7"/>',
  'printer-idle': PRINTER_BADGED + '<path d="M15.75 17.5h3.5"/>',
  'printer-printing': PRINTER_BADGED + '<path d="M16.6 16v3l2.4-1.5z"/>',
  'printer-paused': PRINTER_BADGED + '<path d="M16.4 16v3M18.6 16v3"/>',
  'printer-error': PRINTER_BADGED + '<path d="M17.5 15.9v1.6M17.5 19.2h.01"/>',
  'printer-offline': PRINTER_BADGED.replace('<circle cx="17.5" cy="17.5" r="3.5"/>', '') + '<circle cx="17.5" cy="17.5" r="3.5"/><path d="M15.5 15.5l4 4"/>',
  // Nozzles
  'nozzle-0-2': NOZ(0.6),
  'nozzle-0-4': NOZ(1.1),
  'nozzle-0-6': NOZ(1.6),
  'nozzle-0-8': NOZ(2.1),
  'nozzle-1-0': NOZ(2.6),
  'nozzle-brass': NUT + CONE_CLOSED,
  'nozzle-hardened': '<path d="M6 3.5h12v4.5c0 2.2-2.6 3.6-6 4.6C8.6 11.6 6 10.2 6 8z"/><path d="M10.5 14.5l.7 3.5M13.5 14.5l-.7 3.5"/>',
  'nozzle-stainless': NUT + CONE_CLOSED + '<path d="M9.5 6.5l1.5-2M12.5 6.5l1.5-2"/>',
  'nozzle-ruby': '<rect x="4.5" y="3.5" width="15" height="4" rx="1.5"/><path d="M6 7.5l4 5M18 7.5l-4 5"/><path d="M12 14.5l2.5 2.75L12 20.5l-2.5-3.25z"/>',
  'nozzle-high-flow': '<path d="M8.5 3.5v3M12 3.5v3M15.5 3.5v3"/><rect x="4.5" y="8" width="15" height="4" rx="1.5"/><path d="M6 12l3 7.5M18 12l-3 7.5"/>',
  'nozzle-copper': '<rect x="5.5" y="3.5" width="13" height="3.5" rx="1.5"/><rect x="3.5" y="9" width="17" height="4" rx="1.5"/><path d="M8 13l2.6 5M16 13l-2.6 5"/>',
  'nozzle-clog': NUT + CONE_OPEN + '<path d="M12 16.5h.01" stroke-width="4.5"/>',
  'nozzle-swap': '<rect x="4.5" y="3.5" width="10" height="4" rx="1.5"/><path d="M6 7.5l2.6 5M13 7.5l-2.6 5"/><path d="M19 8.5c1.5 3 .5 6.5-2 8.5M17 17l2-1M17 17l.5-2.5"/>',
  'nozzle-custom': NUT + CONE_CLOSED + '<path d="M4.5 20.5h15"/><circle cx="14" cy="20.5" r="1.25" fill="currentColor" stroke="none"/>',
  'hotend-volcano': '<path d="M7 3.5h10M7 6.5h10M10.5 6.5v3M13.5 6.5v3"/><rect x="6.5" y="9.5" width="11" height="7.5" rx="1.5"/><path d="M9.5 17h5l-1 3.5h-3z"/><path d="M17.5 13h3"/>',
  'extruder-dual': '<circle cx="8" cy="12" r="4.75" stroke-dasharray="1.8 1.6"/><circle cx="16" cy="12" r="4.75" stroke-dasharray="1.8 1.6"/><path d="M8 12h.01M16 12h.01"/>',
  'part-fan': `<path d="${blades(12, 7.5, 0.5)}"/>` + '<circle cx="12" cy="7.5" r="1"/><path d="M4 16c3 0 6-1 8-3.5M20 16c-3 0-6-1-8-3.5"/><path d="M6 20.5h12"/>',
  // Filament
  'color-change': '<path d="M4 20.5h16"/><path d="M4 17h16" stroke-dasharray="2.2 2.4"/><path d="M6 13.5a6.5 6.5 0 0 1 12 0M15 12.5l3 1 1-3"/>',
  'color-change-marker': '<path d="M4 18h16"/><path d="M12 5v8M8 9h8"/>',
  'pause-marker': '<path d="M4 18h16"/><path d="M9.5 5.5v8M14.5 5.5v8"/>',
  'spool-external': SPOOL(10, 12, 6.5) + '<path d="M20.5 4v16M12 12h8.5"/>',
  'spool-refill': SPOOL(10, 13.5, 7, 2) + '<path d="M19 3.5v5M16.5 6h5"/>',
  'spool-rfid': SPOOL(9.5, 14, 6.5, 1.8) + '<path d="M16.5 6.5h.01M16 3.5a5.5 5.5 0 0 1 4.5 4.5M16 6a3 3 0 0 1 2 2"/>',
  'spool-third-party': SPOOL(9, 14, 6.5, 1.8) + '<path d="M16.5 6a2.5 2.5 0 1 1 3.5 2.3c-.6.4-1 .8-1 1.5M19 12.5h.01"/>',
  'spool-weight': '<circle cx="12" cy="9.5" r="5"/><circle cx="12" cy="9.5" r="1.5"/><rect x="4" y="15" width="16" height="5.5" rx="1.5"/><path d="M9 18.75a3 3 0 0 1 6 0M12 18.75l1.25-1.25"/>',
  'flush-volume': '<path d="M4.5 4.5h15l-5.5 7v5h-4v-5z"/><path d="M12 19.5v1"/>',
  'filament-tangle': SPOOL(9, 12, 6.5) + '<path d="M15.5 12h3a2.75 2.75 0 1 1-2.75 2.75v-1.5"/>',
  // Multi-material units
  'unit-ams': '<rect x="3.5" y="6.5" width="17" height="14" rx="2"/><path d="M12 3.5v3"/><path d="M7 11v6M10.3 11v6M13.7 11v6M17 11v6"/>',
  'unit-ams-lite': '<path d="M5 6v11M9.5 6v11M14 6v11M18.5 6v11"/><path d="M3.5 20.5h17"/>',
  'unit-mmu': '<path d="M4 3.5l8 9M8 3.5l4 9M12 3.5v9M16 3.5l-4 9M20 3.5l-8 9"/><path d="M12 12.5v8"/>',
  'unit-toolchanger': '<path d="M3.5 4.5h17"/><rect x="4.25" y="7" width="3.5" height="5" rx="1"/><rect x="10.25" y="7" width="3.5" height="5" rx="1"/><rect x="16.25" y="7" width="3.5" height="5" rx="1"/><path d="M6 12v3M12 12v3M18 12v3"/>',
  'unit-multi-filament-hub': '<circle cx="12" cy="10" r="3"/><path d="M6 3.5l4 4.3M12 3.5V7M18 3.5l-4 4.3"/><path d="M12 13v7.5"/>',
  'slot-1': '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M12 12h.01"/>',
  'slot-2': '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8.5 12h.01M15.5 12h.01"/>',
  'slot-3': '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8.5 15.5h.01M15.5 15.5h.01M12 8.5h.01"/>',
  'slot-4': '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M8.5 15.5h.01M15.5 15.5h.01"/>',
  'unit-link': '<rect x="2.5" y="7.5" width="6.5" height="9" rx="1.5"/><rect x="15" y="7.5" width="6.5" height="9" rx="1.5"/><rect x="8" y="10.5" width="8" height="3" rx="1.5"/>',
  // Bed
  'plate-cool': PLATE + '<path d="M12 8v7M9 9.75l6 3.5M9 13.25l6-3.5"/>',
  'plate-high-temp': PLATE + '<path d="M9 10c1-1.2 2-1.2 3 0s2 1.2 3 0M8 13.5c1-1.2 2-1.2 3 0s2 1.2 3 0"/>',
  'plate-spring-steel': '<path d="M3.5 19c5 0 8-1.5 10.5-6s3.5-8 6.5-9"/><path d="M3.5 21.5c6 0 9.5-2 12-6.5s3.5-7.5 5-8.5"/>',
  'bed-round': '<circle cx="12" cy="12" r="8.5"/><path d="M12 12h.01"/>',
  'bed-rect': '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7.5 15h.01"/>',
  'bed-origin-center': '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M12 12h.01"/>',
  // Connect
  'connect-lan': '<rect x="3.5" y="3.5" width="10" height="10" rx="2"/><path d="M3.5 7h10"/><path d="M8.5 13.5V18h5"/><rect x="13.5" y="15.5" width="7" height="5" rx="1"/><path d="M16.5 18h.01M18.5 18h.01"/>',
  'connect-cloud': CLOUD_S + '<rect x="3.5" y="14" width="9" height="6.5" rx="1.5"/><path d="M8 14v-1.5" stroke-dasharray="1 2.4"/>',
  'connect-relay': '<rect x="2.5" y="8.5" width="5" height="7" rx="1.5"/><rect x="16.5" y="8.5" width="5" height="7" rx="1.5"/><path d="M7.5 12H10M14 12h2.5M12 12h.01"/>',
  'connect-scan': '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.25"/><path d="M12 12l6-6"/><path d="M8.5 15.5h.01"/>',
  'connect-test': '<path d="M3.5 9h3l1.5-4 2.5 8 1.5-4h4"/><path d="M13 18.5l2.5 2.5 5-5.5"/>',
  'connect-fail': '<path d="M3.5 9h3l1.5-4 2.5 8 1.5-4h4"/><path d="M15 16.5l4.5 4.5M19.5 16.5L15 21"/>',
  'connect-cert': SHIELD + '<rect x="9" y="11" width="6" height="5" rx="1"/><path d="M10 11V9.75a2 2 0 0 1 4 0V11"/>',
  'help-guide': '<path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5zM12 6.5v13"/><path d="M6 9.5h3M6 12.5h3"/><path d="M14.75 9.5a1.6 1.6 0 1 1 2 1.5c-.6.3-1 .6-1 1.3M15.75 15h.01"/>',
  // Controls
  'mouse-left': MOUSE + '<path d="M12 10.5V2.5M6.5 10.5h11"/><path d="M12 10.5V3.6a4.4 4.4 0 0 0-4.4 4.4v2.5z" fill="currentColor" stroke="none"/>',
  'mouse-middle': MOUSE + '<path d="M6.5 10.5h11"/><rect x="10.75" y="4.75" width="2.5" height="4" rx="1.25" fill="currentColor" stroke="none"/>',
  'mouse-right': MOUSE + '<path d="M12 10.5V2.5M6.5 10.5h11"/><path d="M12 10.5V3.6a4.4 4.4 0 0 1 4.4 4.4v2.5z" fill="currentColor" stroke="none"/>',
  'mouse-wheel': '<rect x="7.5" y="7" width="9" height="10" rx="4.5"/><path d="M12 9.75v2.5"/><path d="M9.75 5.25L12 3l2.25 2.25M9.75 18.75L12 21l2.25-2.25"/>',
  'trackpad-scroll': PAD + '<path d="M8 10.5h.01M8 13.5h.01"/><path d="M15.5 8v8M13.25 10.25L15.5 8l2.25 2.25M13.25 13.75L15.5 16l2.25-2.25"/>',
  'trackpad-pinch': PAD + '<path d="M8 8l3 3M7.5 11H11V7.5"/><path d="M16 16l-3-3M16.5 13H13v3.5"/>',
  'trackpad-rotate': PAD + '<path d="M16 10.5a4.5 4.5 0 1 0 .5 3.5"/><path d="M16.5 7v3.75h-3.75"/><path d="M12 12h.01"/>',
  'gesture-orbit': '<circle cx="12" cy="12" r="5.5"/><ellipse cx="12" cy="12" rx="9.5" ry="3.5" transform="rotate(-25 12 12)"/>',
  'look-slicerx': LOOK + '<path d="M7 8v12.5M14 8v12.5"/><path d="M9 5.75h3" stroke-width="2.5"/>',
  'look-bambu-studio': LOOK + '<path d="M11 8v12.5M11 16.5h9.5"/>',
  'look-prusaslicer': LOOK + '<path d="M15 8v12.5"/><path d="M5.5 5.75h1.5M9 5.75h1.5M12.5 5.75h1.5M16 5.75h1.5"/>',
  'look-orcaslicer': LOOK + '<path d="M8 8v12.5"/><path d="M12 11.5h.01M15 11.5h.01M18 11.5h.01"/>',
  'keyboard-shortcut': '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M8.5 10l3 2.25-3 2.25M13.5 14.5h2"/>',
  'camera-free': '<path d="M2.5 11c2.2-3.7 5.5-6 9.5-6s7.3 2.3 9.5 6c-2.2 3.7-5.5 6-9.5 6s-7.3-2.3-9.5-6z"/><circle cx="12" cy="11" r="2.75"/><path d="M4.5 20c4.5 1.6 10.5 1.6 15 0"/>',
  // Community
  'donate-coffee': '<path d="M4.5 9h12v5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z"/><path d="M16.5 10.5h1.5a2.5 2.5 0 0 1 0 5h-2"/><path d="M8 3.5c-.8 1 .8 2 0 3M12 3.5c-.8 1 .8 2 0 3"/><path d="M4 21.5h13"/>',
  'donate-heart-hand': '<path d="M12 12.5s-4.5-2.65-4.5-6A2.6 2.6 0 0 1 12 4.95 2.6 2.6 0 0 1 16.5 6.5c0 3.35-4.5 6-4.5 6z"/><path d="M3.5 15.5c0 3 3 5 8.5 5s8.5-2 8.5-5"/>',
  sponsor: '<circle cx="12" cy="12" r="8.5"/>' + HEART_S(8.25),
  'creator-badge': '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20a6.5 6.5 0 0 1 10-5.5"/><path d="M14.5 18l2.25 2.25L21 15.5"/>',
  'role-owner': SHIELD + '<path d="M12 8.5l1.1 2.3 2.5.3-1.8 1.7.5 2.5L12 14.1l-2.3 1.2.5-2.5-1.8-1.7 2.5-.3z"/>',
  'role-moderator': SHIELD + '<path d="M8.5 11.5c1-1.5 2.2-2.2 3.5-2.2s2.5.7 3.5 2.2c-1 1.5-2.2 2.2-3.5 2.2s-2.5-.7-3.5-2.2z"/><path d="M12 11.5h.01"/>',
  'role-creator': '<path d="M8.5 8.5l5 2.8v5.6l-5 2.8-5-2.8v-5.6z"/><path d="M3.5 11.3l5 2.8 5-2.8M8.5 14.1v5.6"/><path d="M15 9.5l4-4 2.5 2.5-4 4-3 .5z"/>',
  'role-member': '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  'queue-review': '<path d="M3.5 7c1-1.7 2.2-2.5 3.5-2.5s2.5.8 3.5 2.5c-1 1.7-2.2 2.5-3.5 2.5S4.5 8.7 3.5 7z"/><path d="M7 7h.01"/><path d="M13 7h7.5M4 13h.01M13 13h7.5M4 18.5h.01M13 18.5h7.5"/>',
  flag: '<path d="M6 21V3.5"/><path d="M6 4.5h11l-2.5 3.5 2.5 3.5H6"/>',
  report: '<path d="M6 21V3.5"/><path d="M6 4.5h12v9H6"/><path d="M12 7v2.5M12 11.75h.01"/>',
  reject: SHIELD + '<path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>',
  'scan-clean': FILE + FILE_FOLD + '<path d="M12 10.5l3.5 1.4v2.6c0 2.1-1.5 3.6-3.5 4.3-2-.7-3.5-2.2-3.5-4.3v-2.6z" transform="translate(0 .5) scale(1)"/><path d="M10.5 15l1 1 2-2.3"/>',
  'scan-flagged': FILE + FILE_FOLD + '<path d="M12 10.5l3.5 1.4v2.6c0 2.1-1.5 3.6-3.5 4.3-2-.7-3.5-2.2-3.5-4.3v-2.6z" transform="translate(0 .5)"/><path d="M12 13v1.75M12 16.5h.01"/>',
  'archive-unsafe': '<path d="M3.5 4.5h17v4h-17z"/><path d="M5 8.5V18a2 2 0 0 0 2 2h4"/><path d="M17.5 12l4 7.5h-8z"/><path d="M17.5 14.75v2.25M17.5 19h.01"/>',
  'file-mesh': FILE + FILE_FOLD + '<path d="M8.5 11h7v6.5h-7zM12 11v6.5M8.5 14.25h7"/>',
  'file-3mf': FILE + FILE_FOLD + '<path d="M12 8.8l2.6 1.4v2.8L12 14.4l-2.6-1.4v-2.8z"/><path d="M9.5 16.5h5M9.5 18.3h5"/>',
  'file-stl': FILE + FILE_FOLD + '<path d="M12 10l4 7.5H8z"/><path d="M10.5 14.75L12 10M10.5 14.75L8 17.5M10.5 14.75l5.5 2.75"/>',
  upload: '<path d="M4 15v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V15"/><path d="M12 15V4M8 8l4-4 4 4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5z"/>',
  // Calibration
  calibration: '<circle cx="12" cy="12" r="6"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="M12 12h.01"/>',
}

export const HARDWARE_ICON_GROUPS = {
  Printers: ['printer-bed-slinger', 'printer-corexy-open', 'printer-corexy-enclosed', 'printer-cartesian-gantry', 'printer-delta', 'printer-idex', 'printer-toolchanger', 'printer-resin', 'printer-custom', 'printer-idle', 'printer-printing', 'printer-paused', 'printer-error', 'printer-offline'],
  Nozzle: ['nozzle-0-2', 'nozzle-0-4', 'nozzle-0-6', 'nozzle-0-8', 'nozzle-1-0', 'nozzle-brass', 'nozzle-hardened', 'nozzle-stainless', 'nozzle-ruby', 'nozzle-high-flow', 'nozzle-copper', 'nozzle-clog', 'nozzle-swap', 'nozzle-custom', 'hotend-volcano', 'extruder-dual', 'part-fan'],
  Filament: ['color-change', 'color-change-marker', 'pause-marker', 'spool-external', 'spool-refill', 'spool-rfid', 'spool-third-party', 'spool-weight', 'flush-volume', 'filament-tangle'],
  'Multi-material': ['unit-ams', 'unit-ams-lite', 'unit-mmu', 'unit-toolchanger', 'unit-multi-filament-hub', 'slot-1', 'slot-2', 'slot-3', 'slot-4', 'unit-link'],
  Bed: ['plate-cool', 'plate-high-temp', 'plate-spring-steel', 'bed-round', 'bed-rect', 'bed-origin-center'],
  Connect: ['connect-lan', 'connect-cloud', 'connect-relay', 'connect-scan', 'connect-test', 'connect-fail', 'connect-cert', 'help-guide'],
  Controls: ['mouse-left', 'mouse-middle', 'mouse-right', 'mouse-wheel', 'trackpad-scroll', 'trackpad-pinch', 'trackpad-rotate', 'gesture-orbit', 'look-slicerx', 'look-bambu-studio', 'look-prusaslicer', 'look-orcaslicer', 'keyboard-shortcut', 'camera-free'],
  Community: ['donate-coffee', 'donate-heart-hand', 'sponsor', 'creator-badge', 'role-owner', 'role-moderator', 'role-creator', 'role-member', 'queue-review', 'flag', 'report', 'reject', 'scan-clean', 'scan-flagged', 'archive-unsafe', 'file-mesh', 'file-3mf', 'file-stl', 'upload', 'globe'],
  Calibration: ['calibration'],
}
