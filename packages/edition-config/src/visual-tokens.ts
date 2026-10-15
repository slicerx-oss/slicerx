// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Color properties an edition can override without changing control geometry.
export const VISUAL_TOKEN_NAMES = [
  '--accent',
  '--ti-t1', '--ti-t2', '--ti-t3', '--ti-ol',
  '--ti-a1', '--ti-a2', '--ti-a3', '--ti-aol',
  '--ti-hl', '--ti-sk', '--ti-sg', '--ti-nd', '--ti-hi', '--ti-sh', '--ti-sh3',
  '--stage-t1', '--stage-t2', '--stage-t3', '--stage-ol',
  '--stage-a1', '--stage-a2', '--stage-a3', '--stage-aol',
  '--stage-cut', '--stage-pill', '--stage-pill-text', '--stage-pill-line',
  '--stage-grid', '--stage-ptr', '--stage-ptr-line',
  '--glyph-line', '--glyph-picked-line', '--glyph-node', '--glyph-picked-node',
  '--glyph-center', '--glyph-halo', '--glyph-picked-edge', '--glyph-picked-halo',
] as const

export type VisualTokenName = (typeof VISUAL_TOKEN_NAMES)[number]
