// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Icons added for the Slice tab: the machine card, the filament rail, the object tree, the selection bar, the
// settings scope and the toolpath controls. Same contract as icons/extra.mjs: a 24px grid, drawn for stroke 1.75
// with round caps and joins, no fill except tiny dots, currentColor. Their 16px versions go in icons/small.mjs.

export const SLICE_ICONS = {
  'negative-part': '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8.5 12h7"/>',
  'support-blocker': '<rect x="5.5" y="3.5" width="13" height="5" rx="1.5"/><path d="M12 8.5v12M8.5 20.5h7"/><path d="M4 19.5l16-14"/>',
  'support-enforcer': '<rect x="3.5" y="3.5" width="12" height="4.5" rx="1.5"/><path d="M9.5 8v12.5M6.5 20.5h6"/><path d="M17.5 11.5v7M14 15h7"/>',
  'select-by-filament': '<path d="M9 3.5c2.4 3 4 5.2 4 7.2a4 4 0 0 1-8 0c0-2 1.6-4.2 4-7.2z"/><path d="M14 13l6.5 2.5-2.75 1.25L16.5 19.5z"/>',
  'move-to-plate': '<path d="M6 6.5h11M14 3.5l3 3-3 3"/><path d="M4.5 14.5h6.5l-2 5H2.5zM15 14.5h6.5l-2 5H13z"/>',
  'skip-object': '<path d="M12 3l7.5 4.25v9L12 20.5l-7.5-4.25v-9z"/><path d="M3.5 3.5l17 17"/>',
  'color-by': '<circle cx="9" cy="9.5" r="5"/><circle cx="15" cy="9.5" r="5"/><circle cx="12" cy="14.5" r="5"/>',
}

export const SLICE_ICON_GROUPS = {
  Slice: ['negative-part', 'support-blocker', 'support-enforcer', 'select-by-filament', 'move-to-plate', 'skip-object', 'color-by'],
}
