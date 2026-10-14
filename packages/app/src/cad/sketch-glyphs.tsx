// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Small marks for the sketch panel's solid settings: which way an extrusion goes (one side, symmetric, two sides) and
// what it does to the body (join, cut, new body). Drawn on the icon set's grid and stroke at 14 px, so they can give way
// to the set's own glyphs once those exist.
export type SketchGlyph = 'oneSide' | 'symmetric' | 'twoSides' | 'join' | 'cut' | 'new'

const PATHS: Record<SketchGlyph, string> = {
  // the sketch plane as a bar, the extrusion as arrows off it
  oneSide: 'M4 18h16M12 18V6M8.5 9.5 12 6l3.5 3.5',
  symmetric: 'M4 12h16M12 12V4M9.5 6.5 12 4l2.5 2.5M12 12v8M9.5 17.5 12 20l2.5-2.5',
  twoSides: 'M4 15h16M12 15V4M9.5 6.5 12 4l2.5 2.5M12 15v5M9.5 17.5 12 20l2.5-2.5',
  // two blocks: one outline when joined, one bitten out of the other for a cut, apart for a new body
  join: 'M4 8h9v-4h7v11h-5v5H4z',
  cut: 'M4 4h16v16H4zM12 12h8v8h-8z',
  new: 'M3 9h9v11H3zM15 4h6v8h-6z',
}

export function SketchGlyphIcon({ kind }: { kind: SketchGlyph }) {
  return (
    <svg className="sketch-glyph" data-glyph={kind} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[kind]} />
      {kind === 'cut' ? <path d="M12 12h8v8h-8z" fill="currentColor" fillOpacity="0.35" stroke="none" /> : null}
    </svg>
  )
}
