// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tool icons' classes. Colors come from the --ti-* tokens (src/tokens.css), which follow the theme: three grays
// and the accent at three light levels, the outline inks, the cavity, the catch light and the shade. Sketch lines
// (sk, skc faint, skf and skcf their pixel fills, nd the white node) take --ti-sk, falling back to the mid accent.
export const TOOL_ICON_CSS = `svg.ti{display:block;flex:none;overflow:visible}
svg.ti path,svg.ti circle,svg.ti ellipse{stroke-linejoin:round;stroke-linecap:round;stroke-width:1px}
svg.ti .t1{fill:var(--ti-t1);stroke:var(--ti-ol)}
svg.ti .t2{fill:var(--ti-t2);stroke:var(--ti-ol)}
svg.ti .t3{fill:var(--ti-t3);stroke:var(--ti-ol)}
svg.ti .a1{fill:var(--ti-a1);stroke:var(--ti-aol)}
svg.ti .a2{fill:var(--ti-a2);stroke:var(--ti-aol)}
svg.ti .a3{fill:var(--ti-a3);stroke:var(--ti-aol)}
svg.ti .hl{fill:var(--ti-hl);stroke:var(--ti-ol)}
svg.ti .nos{stroke:none}
svg.ti .po{fill:var(--ti-ol)}
svg.ti .pa{fill:var(--ti-aol)}
svg.ti .sh{fill:var(--ti-sh)}
svg.ti .sh3{fill:var(--ti-sh3)}
svg.ti .hi{fill:none;stroke:var(--ti-hi);stroke-linecap:butt}
svg.ti .out{fill:none;stroke:var(--ti-ol)}
svg.ti .edge{fill:none;stroke:var(--ti-t3);stroke-linecap:square}
svg.ti .mesh{fill:none;stroke:var(--ti-t3)}
svg.ti .out.ao{stroke:var(--ti-aol)}
svg.ti .lu{fill:none;stroke:var(--ti-ol);stroke-linejoin:miter;stroke-linecap:square}
svg.ti .lg{fill:none;stroke:var(--ti-t2);stroke-linejoin:miter;stroke-linecap:square}
svg.ti .lw{fill:none;stroke:var(--ti-t1);stroke-linecap:square}
svg.ti .ln{fill:none;stroke:var(--ti-a1);stroke-linejoin:miter;stroke-linecap:square}
svg.ti .px{shape-rendering:crispEdges}
svg.ti .sk,svg.ti .skc{fill:none;stroke-width:2px;stroke-linejoin:miter;stroke-linecap:butt}
svg.ti .sk{stroke:var(--ti-sk,var(--ti-a2))}
svg.ti .skc{stroke:var(--ti-skc,color-mix(in srgb,var(--ti-sk,var(--ti-a2)) 50%,transparent))}
svg.ti .skf{fill:var(--ti-sk,var(--ti-a2))}
svg.ti .skcf{fill:var(--ti-skc,color-mix(in srgb,var(--ti-sk,var(--ti-a2)) 50%,transparent))}
svg.ti .nd{fill:var(--ti-nd,white)}
`

/** The key palette the 16 px snap reads colors against, one entry per class a snapped icon uses (the dark default;
 * the sketch colors are keys only, so a theme can set them freely). */
export const SNAP_PALETTE = { t1: '#d6d8e4', t2: '#9da1b6', t3: '#6c7086', a1: '#c9a6fb', a2: '#a57ae8', a3: '#7f58c4', po: '#1a1b24', pa: '#2c1d4a', hl: '#1f2029', skf: '#ff00ff', skcf: '#00ffff', nd: '#ffffff' }
