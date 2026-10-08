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
}
