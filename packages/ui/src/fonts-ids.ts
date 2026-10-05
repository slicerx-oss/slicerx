// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Font ids a theme file may name. Kept apart from fonts.ts so the validator and the picker share one list.
export const FONT_IDS = {
  ui: ['hanken-grotesk', 'inter', 'ibm-plex-sans', 'system'],
  mono: ['jetbrains-mono', 'ibm-plex-mono', 'system'],
} as const satisfies Record<string, readonly string[]>
