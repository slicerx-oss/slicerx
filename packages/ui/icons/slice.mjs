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
  // The print settings tabs (Advanced and Expert) and the sidebar's section icons.
  'tab-quality': '<path d="M6 3h12v1.5h-12zM4.5 4.5h1.5v1.5h-1.5zM18 4.5h1.5v1.5h-1.5zM3 6h1.5v1.5h-1.5zM19.5 6h1.5v1.5h-1.5zM1.5 7.5h21v1.5h-21zM1.5 9h1.5v1.5h-1.5zM21 9h1.5v1.5h-1.5zM3 10.5h1.5v1.5h-1.5zM19.5 10.5h1.5v1.5h-1.5zM4.5 12h1.5v1.5h-1.5zM18 12h1.5v1.5h-1.5zM6 13.5h1.5v1.5h-1.5zM16.5 13.5h1.5v1.5h-1.5zM7.5 15h1.5v1.5h-1.5zM15 15h1.5v1.5h-1.5zM9 16.5h1.5v1.5h-1.5zM13.5 16.5h1.5v1.5h-1.5zM10.5 18h3v1.5h-3z" fill="currentColor" stroke="none"/>',
  'tab-strength': '<path d="M8 12h8"/><rect x="2.5" y="8.5" width="2.5" height="7" rx="1"/><rect x="5" y="6" width="3" height="12" rx="1"/><rect x="16" y="6" width="3" height="12" rx="1"/><rect x="19" y="8.5" width="2.5" height="7" rx="1"/>',
  'tab-speed': '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4.5-5"/><path d="M4 19.5h16"/>',
  'tab-adhesion': '<path d="M3.5 7.5h17l-2.75 2.25 2.75 2.25-2.75 2.25 2.75 2.25h-17l2.75-2.25L3.5 12l2.75-2.25z"/>',
  'tab-color': '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 1.5-2.2-.6-1.4.3-2.8 1.9-2.8H17a3.5 3.5 0 0 0 3.5-3.5c0-4.7-3.8-8.5-8.5-8.5z"/><circle cx="7.75" cy="11" r="1.9" fill="currentColor" stroke="none"/><circle cx="11" cy="7.25" r="1.9" fill="currentColor" stroke="none"/><circle cx="15.75" cy="8.5" r="1.9" fill="currentColor" stroke="none"/>',
  'tab-surface': '<path d="M3.5 9c1.4-1.3 2.8-1.3 4.2 0s2.8 1.3 4.3 0 2.8-1.3 4.2 0 2.8 1.3 4.3 0"/><path d="M3.5 14.5h17M3.5 19.5h17"/>',
  'tab-output': '<path d="M6 3.5h8l4.5 4.5v12.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M14.5 12.75a2.75 2.75 0 1 0 .25 3H13"/>',
  'section-print-settings': '<path d="M4 6.5h3M11 6.5h9M4 12h9M17 12h3M4 17.5h1M9 17.5h11"/><circle cx="9" cy="6.5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="17.5" r="2"/>',
  'section-printer': '<rect x="3.5" y="3" width="17" height="18" rx="2"/><rect x="6.5" y="6.5" width="11" height="10.5" rx="1"/><path d="M12 19v.01" stroke-width="2.5"/>',
}

export const SLICE_ICON_GROUPS = {
  Slice: ['negative-part', 'support-blocker', 'support-enforcer', 'select-by-filament', 'move-to-plate', 'skip-object', 'color-by'],
  'Settings tabs': ['section-printer', 'section-print-settings', 'tab-quality', 'tab-strength', 'tab-speed', 'tab-adhesion', 'tab-color', 'tab-surface', 'tab-output'],
}
