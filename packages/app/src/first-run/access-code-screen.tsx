// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A small looping drawing of the printer's own screen, walking the path to the LAN Only page and
// lighting up the access code, per Bambu Lab family. Drawn in theme tokens; with reduced motion it
// shows the whole path at once.
import { bambuGuide, type BambuFamily } from './bambu-lan'

/** Screen proportions per family: the X1 and H2 touchscreens are wide, the P1 screen is small, the A1 one square. */
const SHAPE: Record<BambuFamily, { w: number; h: number; side: boolean }> = {
  x1: { w: 240, h: 150, side: true },
  h2: { w: 240, h: 150, side: true },
  p1: { w: 200, h: 166, side: false },
  a1: { w: 200, h: 170, side: true },
}

export function AccessCodeScreen({ family }: { family: BambuFamily }) {
  const g = bambuGuide(family)
  const { w, h, side } = SHAPE[family]
  const steps = g.path.length
  // One beat per screen of the path, then the switch, then the code; 1.2 s each.
  const beats = steps + 2
  const dur = `${beats * 1.2}s`
  const at = (i: number) => ({ animationDelay: `${i * 1.2}s`, animationDuration: dur })
  const left = side ? 44 : 10
  const rowW = w - left - 10
  return (
    <figure className="fr-acscreen" aria-labelledby={`fr-ac-cap-${family}`}>
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`The printer screen: ${g.path.join(', then ')}. The access code is on that page.`} style={{ ['--beats' as string]: beats }}>
        <rect className="fr-ac-frame" x="1" y="1" width={w - 2} height={h - 2} rx="12" />
        {side ? (
          <g>
            <rect className="fr-ac-side" x="6" y="6" width="30" height={h - 12} rx="7" />
            {[0, 1, 2, 3].map((n) => (
              <rect key={n} className="fr-ac-ico" x="13" y={16 + n * 26} width="16" height="16" rx="4" />
            ))}
            {/* The settings icon at the bottom of the side bar is the first step. */}
            <rect className="fr-ac-hot" x="11" y={h - 34} width="20" height="20" rx="5" style={at(0)} />
            <circle className="fr-ac-gear" cx="21" cy={h - 24} r="5" />
          </g>
        ) : null}
        {g.path.map((label, i) => {
          if (side && i === 0) return null
          const row = side ? i - 1 : i
          const y = 14 + row * 30
          return (
            <g key={`${label}-${i}`}>
              <rect className="fr-ac-row" x={left} y={y} width={rowW} height="22" rx="6" />
              <rect className="fr-ac-hot" x={left} y={y} width={rowW} height="22" rx="6" style={at(i)} />
              <text className="fr-ac-text" x={left + 10} y={y + 15}>
                {label}
              </text>
              <path className="fr-ac-chev" d={`M${left + rowW - 14} ${y + 7}l5 4-5 4`} />
            </g>
          )
        })}
        {(() => {
          const rows = side ? steps - 1 : steps
          const y = 14 + rows * 30
          return (
            <g>
              <text className="fr-ac-text" x={left + 10} y={y + 15}>
                LAN Only Mode
              </text>
              <rect className="fr-ac-switch" x={left + rowW - 34} y={y + 4} width="28" height="14" rx="7" />
              <rect className="fr-ac-switch-on" x={left + rowW - 34} y={y + 4} width="28" height="14" rx="7" style={at(steps)} />
              <circle className="fr-ac-knob" cx={left + rowW - 27} cy={y + 11} r="5" style={at(steps)} />
              <rect className="fr-ac-code" x={left} y={y + 26} width={rowW} height="22" rx="6" style={at(steps + 1)} />
              <text className="fr-ac-text fr-ac-codetext" x={left + 10} y={y + 41} style={at(steps + 1)}>
                Access code  ● ● ● ● ● ● ● ●
              </text>
            </g>
          )
        })()}
      </svg>
      <figcaption id={`fr-ac-cap-${family}`}>{g.path.join(' > ')} &gt; access code</figcaption>
    </figure>
  )
}
