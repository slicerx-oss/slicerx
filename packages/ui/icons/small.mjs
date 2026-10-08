// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// 16px versions of icons that draw at 16px or smaller (sidebar headers, chips, row actions), keyed by the same name
// as the 24px drawing, which every one of them must have. A 24px drawing scaled down to 16 blurs: its strokes land
// between pixels and its details run together. These are drawn for the size instead: a 16px grid, stroke 1.5, ends
// and corners on quarter pixels so the strokes stay sharp on 2x screens, 1px padding, at most three primitives, no
// dashes, round caps and joins, currentColor. The Icon component picks one whenever it draws at 16px or smaller.

export const SMALL_ICONS = {
  check: '<path d="M3.25 8.25l3 3 6.5-6.5"/>',
  'chevron-down': '<path d="M4.25 6.25L8 10l3.75-3.75"/>',
  'chevron-right': '<path d="M6.25 4.25L10 8l-3.75 3.75"/>',
  close: '<path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/>',
  plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  // the Model tab's icons (icons/model.mjs)
  model: '<path d="M2.75 13.25V7.25a4.5 4.5 0 0 1 4.5-4.5h6v10.5z"/><circle cx="8.75" cy="8.5" r="1.5"/>',
  body: '<path d="M5.5 1.5l4 2.25v4.25L5.5 10.25l-4-2.25V3.75zM1.5 3.75 5.5 6l4-2.25M5.5 6v4.25"/><circle cx="11.5" cy="11.5" r="3.25"/><path d="M11.5 9.75v1.75l1.25 1"/>',
  'mesh-object': '<path d="M8 1.75l5.25 3v6.5L8 14.25l-5.25-3v-6.5z"/><path d="M2.75 4.75 8 14.25l5.25-9.5"/>',
  part: '<path d="M2.75 3.25h10.5v9.5H8.25V9H2.75z"/>',
  modifier: '<path d="M5.5 1.5l4 2.25v4.25L5.5 10.25l-4-2.25V3.75zM1.5 3.75 5.5 6l4-2.25M5.5 6v4.25"/><circle cx="11.5" cy="11.5" r="3.25"/><path d="M9.75 10.75h3.5M9.75 12.25h3.5"/>',
  'box-shape': '<path d="M8 3.5l5.25 2.5v4.75L8 13.25l-5.25-2.5V6z"/><path d="M2.75 6 8 8.5 13.25 6M8 8.5v4.75"/>',
  sketch: '<path d="M1.75 14l3-2.5h9.5l-3 2.5z"/><path d="M10 2l2.5 2.5-5 5H5V7z"/>',
  extrude: '<path d="M1.75 13.5l2.5-2.5h10l-2.5 2.5z"/><path d="M8 8.75V2.25M5.75 4.5 8 2.25l2.25 2.25"/>',
  revolve: '<path d="M8 1.75v12.5"/><path d="M8 3.5h2.5l2 2.5v4l-2 2.5H8"/><path d="M5.75 3.75a5.5 5.5 0 0 0 0 8.5"/>',
  'array-linear': '<rect x="1.75" y="6.25" width="3.5" height="3.5" rx=".75"/><rect x="6.25" y="6.25" width="3.5" height="3.5" rx=".75"/><rect x="10.75" y="6.25" width="3.5" height="3.5" rx=".75"/>',
  'array-polar': '<path d="M2.5 10v.01M5.25 5.25v.01M10.75 5.25v.01M13.5 10v.01" stroke-width="3"/><path d="M8 9v2M7 10h2"/>',
  'repair-mesh': '<path d="M2 13.5 8 2.5l6 11z"/><path d="M8 7.25v4M6 9.25h4"/>',
  'mesh-menu': '<path d="M8 1.75l5.25 3v6.5L8 14.25l-5.25-3v-6.5z"/><path d="M8 1.75v12.5M2.75 4.75l10.5 6.5M13.25 4.75l-10.5 6.5"/>',
  'step-broken': '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
  'select-object': '<rect x="2" y="2" width="7.5" height="7.5" rx="1.5"/><path d="M8.5 8.5l5.5 2.25-2.25 1-1 2.25z"/>',
  'select-face': '<path d="M2 9.5 4.5 2.5h6.5l-2.5 7z"/><circle cx="6.5" cy="6" r="1" fill="currentColor" stroke="none"/><path d="M8.5 8.5l5.5 2.25-2.25 1-1 2.25z"/>',
  'select-edge': '<path d="M2.5 9.5v-6A1.5 1.5 0 0 1 4 2h5.5"/><path d="M2.5 9.5v-6" stroke-width="2.5"/><path d="M8.5 8.5l5.5 2.25-2.25 1-1 2.25z"/>',
  'box-select': '<path d="M1.75 4V1.75H4M7.5 1.75h2.25V4M1.75 6.5v2.25H4M7.5 8.75h2.25V6.5"/><path d="M10.25 9.25l4 1.75-1.75.75-.75 1.75z"/>',
  'roll-to-here': '<path d="M10.5 2v12"/><path d="M2 8h5.5M5.25 5.75 7.5 8l-2.25 2.25"/><path d="M13.5 5v.01M13.5 8v.01M13.5 11v.01"/>',
}
