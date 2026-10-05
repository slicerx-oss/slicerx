// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Small diagrams for setting tooltips, keyed by setting key. Every figure is a 224 by 96 SVG drawn
// with the sx-fig classes only (packages/ui styles.css), so it takes its colors from the theme
// tokens. The animated ones use CSS animations, which stop under reduced motion.
import type { ReactNode } from 'react'

const W = 224
const H = 96
const BED = 86

function Fig({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg className="sx-fig" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
      {children}
    </svg>
  )
}

const Bed = ({ x1 = 8, x2 = 216 }: { x1?: number; x2?: number }) => <line className="fx-bed" x1={x1} y1={BED} x2={x2} y2={BED} />

/** A nozzle with its tip at (x, y). */
const Nozzle = ({ x, y, className = '' }: { x: number; y: number; className?: string }) => <path className={`fx-nozzle ${className}`} d={`M${x - 8} ${y - 18}h16v8l-5 10h-6l-5-10z`} />

const Cap = ({ x, y, children, anchor = 'middle' }: { x: number; y: number; children: string; anchor?: 'start' | 'middle' | 'end' }) => (
  <text className="fx-txt" x={x} y={y} textAnchor={anchor}>
    {children}
  </text>
)

/** A dimension: a dashed line with end ticks. */
function Dim({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const v = x1 === x2
  return (
    <g className="fx-dim">
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      {v ? <line x1={x1 - 3} y1={y1} x2={x1 + 3} y2={y1} /> : <line x1={x1} y1={y1 - 3} x2={x1} y2={y1 + 3} />}
      {v ? <line x1={x2 - 3} y1={y2} x2={x2 + 3} y2={y2} /> : <line x1={x2} y1={y2 - 3} x2={x2} y2={y2 + 3} />}
    </g>
  )
}

/** Rounded loops seen from above, inset step by step. */
function Loops({ x, y, w, h, n, gap = 5, className = 'fx-wall' }: { x: number; y: number; w: number; h: number; n: number; gap?: number; className?: string }) {
  return (
    <g className={className}>
      {Array.from({ length: n }, (_, i) => (
        <rect key={i} x={x + i * gap} y={y + i * gap} width={w - 2 * i * gap} height={h - 2 * i * gap} rx={Math.max(2, 8 - i * 2)} />
      ))}
    </g>
  )
}

/** Diagonal sparse infill lines clipped to a box. */
function Hatch({ x, y, w, h, step, id, className = 'fx-line' }: { x: number; y: number; w: number; h: number; step: number; id: string; className?: string }) {
  const lines: ReactNode[] = []
  for (let d = -h; d < w; d += step) lines.push(<line key={`a${d}`} x1={x + d} y1={y + h} x2={x + d + h} y2={y} />)
  for (let d = 0; d < w + h; d += step) lines.push(<line key={`b${d}`} x1={x + d} y1={y + h} x2={x + d - h} y2={y} />)
  return (
    <g className={className} clipPath={`url(#${id})`}>
      <clipPath id={id}>
        <rect x={x} y={y} width={w} height={h} />
      </clipPath>
      {lines}
    </g>
  )
}

function WallLoops() {
  return (
    <Fig label="Wall loops seen from above">
      <Loops x={60} y={10} w={104} h={72} n={3} />
      <Hatch x={78} y={28} w={68} h={36} step={12} id="fx-wl" />
      <Cap x={190} y={50}>3 loops</Cap>
    </Fig>
  )
}

function Shells({ side }: { side: 'top' | 'bottom' }) {
  const layers = (y0: number, n: number, hot: boolean) =>
    Array.from({ length: n }, (_, i) => <rect key={i} className={hot ? 'fx-solid-hot' : 'fx-solid'} x={44} y={y0 + i * 5} width={136} height={4} rx={1} />)
  return (
    <Fig label={`${side === 'top' ? 'Top' : 'Bottom'} shell layers in a cut through the part`}>
      <Bed />
      <rect className="fx-part" x={40} y={14} width={144} height={72} rx={3} />
      {layers(16, 4, side === 'top')}
      <Hatch x={44} y={37} w={136} h={30} step={10} id={`fx-sh-${side}`} />
      {layers(70, 3, side === 'bottom')}
      <Cap x={188} y={side === 'top' ? 28 : 78} anchor="start">
        {side === 'top' ? 'top' : 'bottom'}
      </Cap>
    </Fig>
  )
}

function Density() {
  const tile = (x: number, step: number, t: string) => (
    <g key={x}>
      <rect className="fx-part" x={x} y={12} width={56} height={56} rx={4} />
      <Hatch x={x + 3} y={15} w={50} h={50} step={step} id={`fx-dn-${x}`} />
      <Cap x={x + 28} y={84}>{t}</Cap>
    </g>
  )
  return <Fig label="Infill density from sparse to dense">{[tile(16, 20, '10%'), tile(84, 11, '20%'), tile(152, 6, '40%')]}</Fig>
}

function Patterns() {
  const box = (x: number) => <rect className="fx-part" x={x} y={12} width={56} height={56} rx={4} />
  const gyroid = Array.from({ length: 5 }, (_, i) => <path key={i} d={`M${86} ${20 + i * 10}c7 -8 14 8 21 0s14 8 21 0 14 8 21 0`} />)
  const hex: ReactNode[] = []
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) {
      const cx = 162 + c * 17 + (r % 2 ? 8 : 0)
      const cy = 22 + r * 14
      hex.push(<path key={`${r}${c}`} d={`M${cx - 8} ${cy}l4 -7h8l4 7l-4 7h-8z`} />)
    }
  return (
    <Fig label="Infill patterns: grid, gyroid and honeycomb">
      {box(16)}
      <Hatch x={19} y={15} w={50} h={50} step={12} id="fx-pt" />
      <Cap x={44} y={84}>grid</Cap>
      {box(84)}
      <g className="fx-line" clipPath="url(#fx-pt2)">
        <clipPath id="fx-pt2">
          <rect x={87} y={15} width={50} height={50} />
        </clipPath>
        {gyroid}
      </g>
      <Cap x={112} y={84}>gyroid</Cap>
      {box(152)}
      <g className="fx-line" clipPath="url(#fx-pt3)">
        <clipPath id="fx-pt3">
          <rect x={155} y={15} width={50} height={50} />
        </clipPath>
        {hex}
      </g>
      <Cap x={180} y={84}>honeycomb</Cap>
    </Fig>
  )
}

function Seam() {
  const cyl = (x: number, dots: number[]) => (
    <g>
      <rect className="fx-part" x={x} y={10} width={64} height={66} rx={6} />
      {Array.from({ length: 11 }, (_, i) => <line key={i} className="fx-layer" x1={x + 2} y1={14 + i * 6} x2={x + 62} y2={14 + i * 6} />)}
      {dots.map((dx, i) => <circle key={i} className="fx-dot" cx={x + dx} cy={14 + i * 6} r={1.8} />)}
    </g>
  )
  return (
    <Fig label="Seam aligned in one line, or scattered at random">
      {cyl(30, Array(11).fill(44))}
      <Cap x={62} y={90}>aligned</Cap>
      {cyl(130, [10, 50, 22, 58, 34, 6, 46, 28, 54, 16, 40])}
      <Cap x={162} y={90}>random</Cap>
    </Fig>
  )
}

function Brim({ gap = false }: { gap?: boolean }) {
  return (
    <Fig label={gap ? 'Gap between the brim and the part' : 'Brim rings around the first layer'}>
      <Loops x={36} y={8} w={110} h={80} n={4} gap={4} className="fx-acc" />
      <rect className="fx-part" x={gap ? 56 : 52} y={gap ? 28 : 24} width={gap ? 70 : 78} height={gap ? 40 : 48} rx={4} />
      {gap ? <Dim x1={51} y1={48} x2={56} y2={48} /> : <Dim x1={36} y1={48} x2={52} y2={48} />}
      <Cap x={186} y={52}>{gap ? 'gap' : 'brim width'}</Cap>
    </Fig>
  )
}

function Skirt() {
  return (
    <Fig label="A skirt loop drawn around the parts">
      <rect className="fx-acc-line" x={30} y={10} width={130} height={76} rx={10} />
      <rect className="fx-part" x={52} y={26} width={86} height={44} rx={4} />
      <Dim x1={30} y1={48} x2={52} y2={48} />
      <Cap x={192} y={52}>distance</Cap>
    </Fig>
  )
}

/** An overhanging part on a bed, shared by the support figures. */
const Ledge = () => <path className="fx-part" d="M70 86V20h120v18H110v48z" />

function Support({ tree = false }: { tree?: boolean }) {
  return (
    <Fig label={tree ? 'Tree support branching up to an overhang' : 'Support columns under an overhang'}>
      <Bed />
      <Ledge />
      {tree ? (
        <g className="fx-sup">
          <path d="M150 86V66l-22 -26M150 66l22 -26M150 72l36 -32" />
          <circle cx={150} cy={86} r={3} />
        </g>
      ) : (
        <g className="fx-sup">
          {[118, 128, 138, 148, 158, 168, 178, 186].map((x) => (
            <line key={x} x1={x} y1={41} x2={x} y2={86} />
          ))}
        </g>
      )}
      <Cap x={40} y={50}>{tree ? 'tree' : 'normal'}</Cap>
    </Fig>
  )
}

function SupportGapZ() {
  return (
    <Fig label="Vertical gap between the support top and the part">
      <rect className="fx-part" x={40} y={14} width={144} height={26} rx={2} />
      <rect className="fx-solid-hot" x={48} y={48} width={128} height={4} />
      <g className="fx-sup">
        {[56, 72, 88, 104, 120, 136, 152, 168].map((x) => (
          <line key={x} x1={x} y1={52} x2={x} y2={86} />
        ))}
      </g>
      <Bed />
      <Dim x1={196} y1={40} x2={196} y2={48} />
      <Cap x={204} y={30} anchor="end">
        gap
      </Cap>
    </Fig>
  )
}

function SupportGapXY() {
  return (
    <Fig label="Sideways gap between support and the part">
      <Bed />
      <Ledge />
      <rect className="fx-part" x={30} y={50} width={30} height={36} rx={2} />
      <g className="fx-sup">
        {[124, 134, 144, 154, 164, 174, 184].map((x) => (
          <line key={x} x1={x} y1={41} x2={x} y2={86} />
        ))}
      </g>
      <Dim x1={110} y1={64} x2={124} y2={64} />
      <Cap x={117} y={95}>XY</Cap>
    </Fig>
  )
}

function SupportAngle() {
  return (
    <Fig label="Overhangs flatter than the threshold angle get support">
      <Bed />
      <path className="fx-part" d="M30 86L70 30h40L84 86z" />
      <path className="fx-part" d="M120 86V40l84 -14v14l-64 0v46z" />
      <g className="fx-sup">
        {[150, 162, 174, 186, 198].map((x) => (
          <line key={x} x1={x} y1={42} x2={x} y2={86} />
        ))}
      </g>
      <path className="fx-dim" d="M84 86a14 14 0 0 0 -6 -12" />
      <Cap x={60} y={22}>steep: none</Cap>
      <Cap x={170} y={20}>flat: support</Cap>
    </Fig>
  )
}

function Interface() {
  return (
    <Fig label="Dense interface layers at the top of the support">
      <rect className="fx-part" x={40} y={12} width={144} height={22} rx={2} />
      {[0, 1, 2].map((i) => (
        <rect key={i} className="fx-solid-hot" x={48} y={40 + i * 5} width={128} height={4} />
      ))}
      <g className="fx-sup">
        {[60, 84, 108, 132, 156].map((x) => (
          <line key={x} x1={x} y1={55} x2={x} y2={86} />
        ))}
      </g>
      <Bed />
      <Cap x={182} y={50} anchor="start">
        interface
      </Cap>
    </Fig>
  )
}

function Raft() {
  return (
    <Fig label="The part printed on raft layers">
      <Bed />
      {[0, 1, 2].map((i) => (
        <rect key={i} className={i === 0 ? 'fx-solid' : 'fx-solid-hot'} x={30 + i * 3} y={80 - i * 6} width={164 - i * 6} height={5} rx={1} />
      ))}
      <rect className="fx-part" x={62} y={20} width={100} height={47} rx={3} />
      <Cap x={198} y={78} anchor="start">
        raft
      </Cap>
    </Fig>
  )
}

function Ironing() {
  return (
    <Fig label="The nozzle passes over the top surface again to smooth it">
      <rect className="fx-part" x={20} y={58} width={184} height={28} rx={2} />
      <path className="fx-rough" d="M20 58q4 -3 8 0t8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0 8 0" />
      <line className="fx-smooth fx-a-iron-trail" x1={20} y1={58} x2={204} y2={58} />
      <g className="fx-a-iron">
        <Nozzle x={30} y={56} />
      </g>
    </Fig>
  )
}

function ZHop({ only }: { only?: 'normal' }) {
  return (
    <Fig label="How the nozzle lifts for travel: normal, slope or spiral">
      <rect className="fx-part" x={16} y={60} width={192} height={26} rx={2} />
      <path className="fx-travel fx-a-draw" d="M24 58V36h48v22" />
      <Cap x={48} y={30}>normal</Cap>
      {only ? null : (
        <>
          <path className="fx-travel fx-a-draw" d="M88 58l18 -22h12l18 22" />
          <Cap x={112} y={30}>slope</Cap>
          <path className="fx-travel fx-a-draw" d="M156 58c-8 -4 8 -8 0 -12s8 -8 0 -12c10 0 30 0 38 0v24" />
          <Cap x={176} y={18}>spiral</Cap>
        </>
      )}
    </Fig>
  )
}

function ZHopHeight() {
  return (
    <Fig label="The nozzle lifts by the z hop height before traveling">
      <rect className="fx-part" x={30} y={56} width={164} height={30} rx={2} />
      <Nozzle x={70} y={40} />
      <path className="fx-travel" d="M70 56V40h90v16" />
      <Dim x1={176} y1={40} x2={176} y2={56} />
      <Cap x={200} y={52}>hop</Cap>
    </Fig>
  )
}

function Retraction() {
  return (
    <Fig label="The filament pulls back before a travel and pushes forward after">
      <rect className="fx-tube" x={100} y={4} width={24} height={60} rx={3} />
      <rect className="fx-filament fx-a-retract" x={106} y={4} width={12} height={62} rx={2} />
      <Nozzle x={112} y={82} />
      <line className="fx-ooze fx-a-ooze" x1={112} y1={84} x2={112} y2={92} />
      <Cap x={150} y={36} anchor="start">
        pull back
      </Cap>
      <path className="fx-dim" d="M144 22v26m-3 -23 3 -3 3 3" />
    </Fig>
  )
}

function Wipe() {
  return (
    <Fig label="The nozzle wipes back along the line it just printed">
      <rect className="fx-part" x={20} y={60} width={184} height={26} rx={2} />
      <line className="fx-wall-line" x1={30} y1={58} x2={170} y2={58} />
      <line className="fx-hot fx-a-wipe" x1={170} y1={58} x2={130} y2={58} />
      <g className="fx-a-wipe-nozzle">
        <Nozzle x={170} y={56} />
      </g>
      <Cap x={150} y={24}>wipe</Cap>
    </Fig>
  )
}

function LayerHeight({ first = false }: { first?: boolean }) {
  const stairs = (x: number, step: number, n: number) => {
    let d = `M${x} ${BED}`
    for (let i = 0; i < n; i++) d += `v${-step}h${(60 / n) | 0}`
    return d
  }
  if (first)
    return (
      <Fig label="The first layer is thicker than the rest">
        <Bed />
        {Array.from({ length: 8 }, (_, i) => (
          <rect key={i} className={i === 0 ? 'fx-solid-hot' : 'fx-solid'} x={50} y={i === 0 ? 78 : 78 - i * 8} width={124} height={i === 0 ? 8 : 6} rx={1} />
        ))}
        <Cap x={200} y={84}>first</Cap>
      </Fig>
    )
  return (
    <Fig label="Thin layers follow a slope more closely than thick ones">
      <Bed />
      <path className="fx-ghost" d="M20 86L90 16" />
      <path className="fx-wall-line" d={stairs(20, 14, 5)} />
      <path className="fx-ghost" d="M128 86L198 16" />
      <path className="fx-wall-line" d={stairs(128, 7, 10)} />
      <Cap x={70} y={60}>thick</Cap>
      <Cap x={178} y={60}>thin</Cap>
    </Fig>
  )
}

function SmartLayer() {
  const ys = [86, 78, 70, 62, 54, 47, 41, 36, 32, 29, 27]
  return (
    <Fig label="sleipnir: thick layers on straight walls, thin layers on the dome">
      <Bed />
      <path className="fx-part" d="M60 86V46a52 26 0 0 1 104 0v40z" />
      {ys.map((y, i) => (
        <line key={i} className={i > 4 ? 'fx-acc-line' : 'fx-layer'} x1={60} y1={y} x2={164} y2={y} />
      ))}
      <Cap x={196} y={34}>thin</Cap>
      <Cap x={196} y={74}>thick</Cap>
    </Fig>
  )
}

function Fuzzy() {
  let d = 'M128 14'
  for (let y = 18; y <= 86; y += 4) d += `L${128 + ((y * 7) % 5) - 2} ${y}`
  return (
    <Fig label="Fuzzy skin jitters the outer wall">
      <Bed />
      <path className="fx-part" d="M40 86V14h56v72z" />
      <path className="fx-part" d={`M${d.slice(1)}H184V14z`} />
      <path className="fx-wall-line" d={d} />
      <Cap x={68} y={10}>off</Cap>
      <Cap x={156} y={10}>fuzzy</Cap>
    </Fig>
  )
}

function Bridge({ thick = false }: { thick?: boolean }) {
  return (
    <Fig label={thick ? 'Thick, round bridge strands' : 'Bridge strands spanning a gap'}>
      <Bed />
      <rect className="fx-part" x={24} y={34} width={40} height={52} rx={2} />
      <rect className="fx-part" x={160} y={34} width={40} height={52} rx={2} />
      {thick ? (
        Array.from({ length: 8 }, (_, i) => <circle key={i} className="fx-strand" cx={78 + i * 10} cy={30} r={5} />)
      ) : (
        <path className="fx-strand-line" d="M24 30H200" />
      )}
      {thick ? null : <path className="fx-ghost" d="M64 32q48 10 96 0" />}
      <Cap x={112} y={66}>{thick ? 'round strands' : 'bridge'}</Cap>
    </Fig>
  )
}

function Overhang() {
  return (
    <Fig label="Walls slow down as they hang further out">
      <Bed />
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} className={i > 3 ? 'fx-solid-hot' : 'fx-solid'} x={72 + i * i * 1.6} y={80 - i * 8} width={56} height={6} rx={1} />
      ))}
      <Cap x={10} y={30} anchor="start">slower</Cap>
      <Cap x={10} y={82} anchor="start">full speed</Cap>
    </Fig>
  )
}

function ElephantFoot() {
  return (
    <Fig label="The first layer bulge and the shrunk first layer">
      <Bed />
      <path className="fx-part" d="M30 86c-6 0 -6 -6 0 -6V20h60v60c6 0 6 6 0 6z" />
      <path className="fx-part" d="M134 86V20h60v66z" />
      <rect className="fx-solid-hot" x={136} y={80} width={56} height={5} />
      <Cap x={60} y={14}>bulge</Cap>
      <Cap x={164} y={14}>compensated</Cap>
    </Fig>
  )
}

function HoleComp({ contour = false }: { contour?: boolean }) {
  return (
    <Fig label={contour ? 'The outside of the part grows or shrinks' : 'Holes grow or shrink'}>
      <rect className={contour ? 'fx-ghost' : 'fx-part'} x={50} y={8} width={124} height={80} rx={6} />
      {contour ? <rect className="fx-part" x={56} y={14} width={112} height={68} rx={5} /> : null}
      <circle className={contour ? 'fx-hole' : 'fx-ghost'} cx={112} cy={48} r={contour ? 18 : 24} />
      {contour ? null : <circle className="fx-hole" cx={112} cy={48} r={18} />}
      <path className="fx-dim" d={contour ? 'M168 48h6m-3 -3 3 3 -3 3' : 'M130 48h6m-3 -3 3 3 -3 3'} />
    </Fig>
  )
}

function WallOrder() {
  return (
    <Fig label="Wall order: inner walls first, then the outer wall">
      <Loops x={40} y={8} w={124} h={80} n={3} gap={12} />
      <Cap x={46} y={51}>3</Cap>
      <Cap x={58} y={51}>2</Cap>
      <Cap x={70} y={51}>1</Cap>
      <Cap x={196} y={50}>outer last</Cap>
    </Fig>
  )
}

function Scarf() {
  return (
    <Fig label="A scarf seam ramps the loop ends over each other">
      <rect className="fx-part" x={20} y={40} width={80} height={20} rx={1} />
      <line className="fx-dim" x1={60} y1={40} x2={60} y2={60} />
      <Cap x={60} y={30}>butt joint</Cap>
      <path className="fx-part" d="M124 60L204 40v20z" />
      <path className="fx-solid-hot" d="M124 40h80L124 60z" />
      <Cap x={164} y={30}>scarf</Cap>
    </Fig>
  )
}

function WallGen() {
  return (
    <Fig label="Variable-width walls fill a thin wedge; constant walls leave a gap">
      <path className="fx-part" d="M20 82L60 14l40 68z" />
      <path className="fx-wall-line" d="M30 78L60 26l30 52M42 78L60 46l18 32" />
      <circle className="fx-gap" cx={60} cy={64} r={3} />
      <Cap x={60} y={94}>classic</Cap>
      <path className="fx-part" d="M124 82L164 14l40 68z" />
      <path className="fx-wide" d="M134 78L164 26l30 52" />
      <path className="fx-wide fx-wide-2" d="M146 78L164 44l18 34" />
      <Cap x={164} y={94}>aegis</Cap>
    </Fig>
  )
}

function Vase() {
  return (
    <Fig label="Spiral vase: one wall rising in a continuous spiral">
      <Bed />
      <path className="fx-part" d="M80 86l-8 -70h80l-8 70z" />
      <path className="fx-wall-line" d={Array.from({ length: 8 }, (_, i) => {
        const y = 84 - i * 8.6
        const l = 80 - (86 - y) * 0.114
        return `M${l.toFixed(1)} ${y.toFixed(1)}L${(224 - l).toFixed(1)} ${(y - 6).toFixed(1)}`
      }).join('')} />
      <Cap x={190} y={50}>no seam</Cap>
    </Fig>
  )
}

function TopPattern() {
  return (
    <Fig label="Monotonic top lines all laid in one direction, or concentric loops">
      <rect className="fx-part" x={16} y={12} width={88} height={64} rx={3} />
      {Array.from({ length: 8 }, (_, i) => (
        <line key={i} className="fx-wall-line" x1={22 + i * 11} y1={16} x2={22 + i * 11} y2={72} />
      ))}
      <path className="fx-dim" d="M24 84h72m-4 -3 4 3 -4 3" />
      <Cap x={60} y={94}>monotonic</Cap>
      <rect className="fx-part" x={120} y={12} width={88} height={64} rx={3} />
      <Loops x={124} y={16} w={80} h={56} n={5} gap={5} className="fx-wall" />
      <Cap x={164} y={94}>concentric</Cap>
    </Fig>
  )
}

function OneWallTop() {
  return (
    <Fig label="One wall on the top surface leaves more room for the top pattern">
      <Loops x={50} y={8} w={124} h={80} n={1} />
      {Array.from({ length: 10 }, (_, i) => (
        <line key={i} className="fx-line" x1={60 + i * 11} y1={14} x2={60 + i * 11} y2={82} />
      ))}
    </Fig>
  )
}

function PrimeTower() {
  return (
    <Fig label="A prime tower beside the part takes the purge on color changes">
      <Bed />
      <rect className="fx-part" x={30} y={30} width={96} height={56} rx={3} />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} className={i % 2 ? 'fx-solid-hot' : 'fx-solid-alt'} x={160} y={20 + i * 9.4} width={30} height={8.4} />
      ))}
      <Cap x={175} y={14}>tower</Cap>
    </Fig>
  )
}

function AvoidWalls() {
  return (
    <Fig label="Travel goes around walls instead of crossing them">
      <rect className="fx-part" x={30} y={14} width={164} height={68} rx={6} />
      <circle className="fx-hole" cx={112} cy={48} r={18} />
      <circle className="fx-dot" cx={60} cy={48} r={3} />
      <circle className="fx-dot" cx={164} cy={48} r={3} />
      <line className="fx-ghost" x1={60} y1={48} x2={164} y2={48} />
      <path className="fx-travel" d="M60 48C70 20 154 20 164 48" />
    </Fig>
  )
}

function LineWidth() {
  return (
    <Fig label="Line width: narrow and wide beads in a cut">
      <Bed />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect className="fx-solid" x={26 + i * 22} y={70} width={21} height={15} rx={7} />
          <rect className="fx-solid" x={26 + i * 22} y={54} width={21} height={15} rx={7} />
        </g>
      ))}
      {[0, 1].map((i) => (
        <g key={i}>
          <rect className="fx-solid-hot" x={128 + i * 35} y={70} width={34} height={15} rx={7} />
          <rect className="fx-solid-hot" x={128 + i * 35} y={54} width={34} height={15} rx={7} />
        </g>
      ))}
      <Cap x={58} y={44}>narrow</Cap>
      <Cap x={162} y={44}>wide</Cap>
    </Fig>
  )
}

function Polyhole() {
  const poly = (cx: number, n: number) =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2
      return `${i ? 'L' : 'M'}${(cx + 24 * Math.cos(a)).toFixed(1)} ${(46 + 24 * Math.sin(a)).toFixed(1)}`
    }).join('') + 'z'
  return (
    <Fig label="A round hole printed as a polygon with fewer, flat sides">
      <circle className="fx-hole" cx={60} cy={46} r={24} />
      <path className="fx-hole" d={poly(164, 7)} />
      <Cap x={60} y={90}>round</Cap>
      <Cap x={164} y={90}>polyhole</Cap>
    </Fig>
  )
}

function Printable() {
  return (
    <Fig label="Material fills in under a steep overhang so it prints without support">
      <Bed />
      <Ledge />
      <path className="fx-solid-hot" d="M110 86V38h80l-48 48z" />
      <Cap x={40} y={50}>cone</Cap>
    </Fig>
  )
}

function Waves() {
  return (
    <Fig label="Wave overhangs grow rings outward from the supported edge">
      <rect className="fx-part" x={20} y={12} width={60} height={72} rx={3} />
      {Array.from({ length: 7 }, (_, i) => (
        <path key={i} className={i % 2 ? 'fx-acc-line' : 'fx-wall-line'} d={`M80 ${18 - i}a${12 + i * 12} ${30 + i * 0.5} 0 0 1 0 ${60 + i * 2}`} />
      ))}
      <Cap x={216} y={52} anchor="end">rings</Cap>
    </Fig>
  )
}

function Interlock() {
  return (
    <Fig label="Beams of two filaments weave into each other where they meet">
      <rect className="fx-part" x={30} y={14} width={82} height={68} />
      <rect className="fx-solid-alt" x={112} y={14} width={82} height={68} />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} className={i % 2 ? 'fx-part' : 'fx-solid-alt'} x={i % 2 ? 112 : 96} y={14 + i * 11.3} width={16} height={11.3} />
      ))}
    </Fig>
  )
}

function DraftShield() {
  return (
    <Fig label="A draft shield is a thin wall as tall as the print">
      <Bed />
      <rect className="fx-acc" x={30} y={20} width={4} height={66} />
      <rect className="fx-acc" x={190} y={20} width={4} height={66} />
      <rect className="fx-part" x={70} y={20} width={84} height={66} rx={3} />
    </Fig>
  )
}

function VerticalShell() {
  return (
    <Fig label="Solid infill is added under sloped surfaces">
      <Bed />
      <path className="fx-part" d="M30 86V20h60l90 66z" />
      <path className="fx-solid-hot" d="M90 20l90 66h-18l-78 -57z" />
      <Hatch x={34} y={30} w={60} h={52} step={10} id="fx-vs" />
    </Fig>
  )
}

function AltWall() {
  return (
    <Fig label="An extra wall on every other layer locks the infill between walls">
      <Bed />
      {Array.from({ length: 8 }, (_, i) => (
        <g key={i}>
          <rect className="fx-solid" x={40} y={78 - i * 8} width={i % 2 ? 22 : 14} height={6} rx={1} />
          <rect className="fx-solid" x={i % 2 ? 162 : 170} y={78 - i * 8} width={i % 2 ? 22 : 14} height={6} rx={1} />
        </g>
      ))}
      <Hatch x={64} y={22} w={96} h={62} step={14} id="fx-aw" />
    </Fig>
  )
}

const FIGURES: Readonly<Record<string, () => ReactNode>> = {
  wall_loops: WallLoops,
  top_shell_layers: () => <Shells side="top" />,
  bottom_shell_layers: () => <Shells side="bottom" />,
  sparse_infill_density: Density,
  sparse_infill_pattern: Patterns,
  seam_position: Seam,
  brim_type: () => <Brim />,
  brim_object_gap: () => <Brim gap />,
  skirt_loops: Skirt,
  enable_support: () => <Support />,
  support_type: () => <Support tree />,
  support_top_z_distance: SupportGapZ,
  support_object_xy_distance: SupportGapXY,
  support_threshold_angle: SupportAngle,
  support_interface_top_layers: Interface,
  raft_layers: Raft,
  ironing_type: Ironing,
  z_hop_types: () => <ZHop />,
  z_hop: ZHopHeight,
  retraction_length: Retraction,
  wipe: Wipe,
  layer_height: () => <LayerHeight />,
  initial_layer_print_height: () => <LayerHeight first />,
  smart_layer: SmartLayer,
  fuzzy_skin: Fuzzy,
  bridge_flow: () => <Bridge />,
  thick_bridges: () => <Bridge thick />,
  enable_overhang_speed: Overhang,
  elefant_foot_compensation: ElephantFoot,
  xy_hole_compensation: () => <HoleComp />,
  xy_contour_compensation: () => <HoleComp contour />,
  wall_sequence: WallOrder,
  seam_slope_type: Scarf,
  wall_generator: WallGen,
  spiral_mode: Vase,
  top_surface_pattern: TopPattern,
  only_one_wall_top: OneWallTop,
  enable_prime_tower: PrimeTower,
  reduce_crossing_wall: AvoidWalls,
  line_width: LineWidth,
  hole_to_polyhole: Polyhole,
  make_overhang_printable: Printable,
  wave_overhangs: Waves,
  interlocking_beam: Interlock,
  draft_shield: DraftShield,
  ensure_vertical_shell_thickness: VerticalShell,
  alternate_extra_wall: AltWall,
}

/** Keys that share another key's figure. */
const SAME_AS: Readonly<Record<string, string>> = {
  top_shell_thickness: 'top_shell_layers',
  bottom_shell_thickness: 'bottom_shell_layers',
  brim_width: 'brim_type',
  skirt_distance: 'skirt_loops',
  support_style: 'support_type',
  support_bottom_z_distance: 'support_top_z_distance',
  support_threshold_overlap: 'support_threshold_angle',
  support_interface_spacing: 'support_interface_top_layers',
  ironing_flow: 'ironing_type',
  ironing_speed: 'ironing_type',
  ironing_spacing: 'ironing_type',
  filament_z_hop_types: 'z_hop_types',
  filament_z_hop: 'z_hop',
  retraction_speed: 'retraction_length',
  filament_retraction_length: 'retraction_length',
  filament_wipe: 'wipe',
  wipe_distance: 'wipe',
  smart_layer_min_height: 'smart_layer',
  smart_layer_max_height: 'smart_layer',
  fuzzy_skin_thickness: 'fuzzy_skin',
  fuzzy_skin_point_distance: 'fuzzy_skin',
  bridge_speed: 'bridge_flow',
  bridge_density: 'bridge_flow',
  overhang_1_4_speed: 'enable_overhang_speed',
  overhang_2_4_speed: 'enable_overhang_speed',
  overhang_3_4_speed: 'enable_overhang_speed',
  overhang_4_4_speed: 'enable_overhang_speed',
  seam_slope_min_length: 'seam_slope_type',
  spiral_mode_smooth: 'spiral_mode',
  bottom_surface_pattern: 'top_surface_pattern',
  prime_tower_width: 'enable_prime_tower',
  outer_wall_line_width: 'line_width',
  inner_wall_line_width: 'line_width',
}

/** Keys with a figure of their own (not counting the ones that share one). */
export const FIGURE_KEYS: readonly string[] = Object.keys(FIGURES)

/** The figure for a setting, or null when it has none. */
export function settingFigure(key: string): ReactNode {
  const f = FIGURES[key] ?? FIGURES[SAME_AS[key] ?? '']
  return f ? f() : null
}

export function hasSettingFigure(key: string): boolean {
  return key in FIGURES || key in SAME_AS
}
