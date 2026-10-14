// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tool icons' classes. Colors come from the --ti-* tokens (src/tokens.css), which follow the theme: three grays,
// the accent at three light levels, the contour inks and the cavity. Sketch strokes take --ti-sk (the accent line)
// and --ti-sg (the gray line); nd is the white vertex node.
export const TOOL_ICON_CSS = `svg.ti{display:block;flex:none;overflow:visible}
svg.ti path,svg.ti ellipse{stroke-linejoin:round;stroke-width:1px}
svg.ti .t1{fill:var(--ti-t1);stroke:var(--ti-ol)}
svg.ti .t2{fill:var(--ti-t2);stroke:var(--ti-ol)}
svg.ti .t3{fill:var(--ti-t3);stroke:var(--ti-ol)}
svg.ti .a1{fill:var(--ti-a1);stroke:var(--ti-aol)}
svg.ti .a2{fill:var(--ti-a2);stroke:var(--ti-aol)}
svg.ti .a3{fill:var(--ti-a3);stroke:var(--ti-aol)}
svg.ti .hl{fill:var(--ti-hl);stroke:none}
svg.ti .cya{fill:url(#ti-cya)}
svg.ti .cyg{fill:url(#ti-cyg)}
svg.ti .out{stroke:var(--ti-ol)}
svg.ti .out.ao{stroke:var(--ti-aol)}
svg.ti .nf{fill:none}
svg.ti .mesh{fill:none;stroke:var(--ti-ol);stroke-opacity:.5;stroke-width:.8px}
svg.ti .ln{fill:none;stroke:var(--ti-sk);stroke-width:1.5px;stroke-linecap:round}
svg.ti .sk{fill:none;stroke:var(--ti-sk);stroke-width:2px;stroke-linejoin:miter}
svg.ti .lg{fill:none;stroke:var(--ti-sg);stroke-width:1px}
svg.ti .dash{stroke-dasharray:2.5 2}
svg.ti .dash2{stroke-dasharray:4 3}
svg.ti .faint{stroke-opacity:.45}
svg.ti .faint2{fill-opacity:.4}
svg.ti .nd{fill:var(--ti-nd,white);stroke:var(--ti-ol)}
svg.ti .px{shape-rendering:crispEdges}
svg.ti .po{fill:var(--ti-ol)}
svg.ti .pa{fill:var(--ti-aol)}
svg.ti .skf{fill:var(--ti-sk)}
svg.ti .skcf{fill:var(--ti-sk);fill-opacity:.45}
svg.ti .sgf{fill:var(--ti-sg)}
svg.ti .nos{stroke:none}
`

/** The dark default colors, for sheets drawn outside the app. */
export const SNAP_PALETTE = { t1: '#d6d8e4', t2: '#9da1b6', t3: '#6c7086', a1: '#cfb1fa', a2: '#a681db', a3: '#795e9f', po: '#1a1b24', pa: '#2a2037', hl: '#1f2029', skf: '#cfb1fa', skcf: '#cfb1fa', sgf: '#9da1b6', nd: '#ffffff' }
