// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useId } from 'react'
import { COVER_PROFILE, isoView } from '../../export/cover-profile'

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Stand-in cover for a listing with no image, in the shop drawing look of the
 * drawn covers: the 10 mm grid seen from the same camera and a dashed box sized
 * from the slug, so a row of empty cards still reads as one set.
 */
export function DrawingArt({ seed }: { seed: string }) {
  const id = useId()
  const h = hash(seed)
  const size = [20 + (h % 5) * 8, 16 + ((h >>> 4) % 5) * 8, 12 + ((h >>> 8) % 6) * 8] as const
  const [bx, by, bz] = size
  const corners = [0, 1].flatMap((k) => [[-bx / 2, -by / 2], [bx / 2, -by / 2], [bx / 2, by / 2], [-bx / 2, by / 2]].map(([x, y]) => isoView(x!, y!, k * bz)))
  const W = 400
  const H = 300
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const s = Math.min((W * COVER_PROFILE.fitWidth) / (Math.max(...xs) - Math.min(...xs)), (H * COVER_PROFILE.fitHeight) / (Math.max(...ys) - Math.min(...ys)))
  const ox = W / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * s
  const oy = H * COVER_PROFILE.base + Math.min(...ys) * s
  const pt = (x: number, y: number, z: number) => {
    const v = isoView(x, y, z)
    return `${(ox + v[0] * s).toFixed(1)} ${(oy - v[1] * s).toFixed(1)}`
  }
  const g = COVER_PROFILE.gridMm
  const reach = Math.ceil(W / s / g) * g
  let grid = ''
  for (let v = -reach; v <= reach; v += g) grid += `M${pt(v, -reach, 0)}L${pt(v, reach, 0)}M${pt(-reach, v, 0)}L${pt(reach, v, 0)}`
  let box = ''
  for (let k = 0; k < 4; k++) {
    const a = corners[k]!
    const b = corners[(k + 1) % 4]!
    const at = corners[k + 4]!
    const bt = corners[((k + 1) % 4) + 4]!
    const p = (c: readonly number[]) => `${(ox + c[0]! * s).toFixed(1)} ${(oy - c[1]! * s).toFixed(1)}`
    box += `M${p(a)}L${p(b)}M${p(at)}L${p(bt)}M${p(a)}L${p(at)}`
  }
  return (
    <svg className="drawing-art" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}f`} cx="50%" cy="60%" r="62%">
          <stop offset="0.4" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}m`}>
          <rect width={W} height={H} fill={`url(#${id}f)`} />
        </mask>
      </defs>
      <path className="drawing-art-grid" d={grid} mask={`url(#${id}m)`} />
      <path className="drawing-art-box" d={box} />
    </svg>
  )
}
