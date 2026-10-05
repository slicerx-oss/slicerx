// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// App-level pieces @slicerx/ui does not have: a filament swatch and generated cover art.
import type { CSSProperties } from 'react'

/** A filament color dot. The color is data (a spool's #rrggbb), not a style token. */
export function Swatch({ color, size }: { color: string; size?: 'sm' }) {
  return <i className={size ? `swatch ${size}` : 'swatch'} style={{ '--c': color } as CSSProperties} aria-hidden="true" />
}

const ART_TONES = ['var(--purple)', 'var(--pink)', 'var(--cyan)', 'var(--orange)', 'var(--green)']

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Cover art for a model with no image yet: its silhouette as a stack of print
 * layers, shaped and tinted from the slug, so each listing reads as a distinct object.
 */
export function LayerArt({ seed, layers = 16, muted }: { seed: string; layers?: number; muted?: boolean }) {
  const h = hash(seed)
  // Muted art is one neutral tone, for grids where color would read as decoration.
  const tone = muted ? 'var(--muted)' : (ART_TONES[h % ART_TONES.length] ?? 'var(--purple)')
  const shape = (h >>> 3) % 7
  const scale = 0.7 + ((h >>> 9) % 30) / 100
  const rows = Array.from({ length: layers }, (_, i) => {
    const t = i / (layers - 1)
    const wobble = (((h >>> (i % 24)) & 7) - 3.5) * 0.01
    let w: number
    switch (shape) {
      case 0: w = Math.sin(Math.PI * (0.06 + t * 0.88)); break // sphere
      case 1: w = 0.3 + 0.62 * (1 - t); break // cone
      case 2: w = t < 0.18 ? 0.95 : 0.4; break // base and post
      case 3: w = 0.55 + 0.3 * Math.sin(t * Math.PI * 2); break // vase
      case 4: w = 0.45 + 0.5 * t * t; break // bowl
      case 5: w = t > 0.8 ? 0.8 - (t - 0.8) * 2 : 0.8; break // box with a rounded top
      default: w = 0.3 + 0.6 * Math.abs(t - 0.5) * 2 // hourglass
    }
    return Math.max(0.12, Math.min(0.96, w * scale + wobble))
  })
  return (
    <span className="layer-art" style={{ '--tone': tone } as CSSProperties} aria-hidden="true">
      {rows.map((w, i) => (
        <i key={i} style={{ width: `${Math.round(w * 100)}%`, opacity: 0.35 + (i / layers) * 0.65 }} />
      ))}
    </span>
  )
}

/**
 * A model's silhouette, drawn from its triangles and seen along its thinnest
 * axis, so flat parts show their outline. For models small enough to draw whole.
 */
export function Silhouette({ parts }: { parts: readonly { positions: Float32Array; indices: Uint32Array }[] }) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    for (let i = 0; i + 2 < p.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p.positions[i + a] ?? 0
        lo[a] = Math.min(lo[a] ?? v, v)
        hi[a] = Math.max(hi[a] ?? v, v)
      }
    }
  }
  const ext = [0, 1, 2].map((a) => (hi[a] ?? 0) - (lo[a] ?? 0))
  const thin = ext.indexOf(Math.min(...ext))
  // Horizontal axis is X unless X is the thin one; vertical is Z unless Z is (then Y, seen from above).
  const u = thin === 0 ? 1 : 0
  const v = thin === 2 ? 1 : 2
  const size = Math.max(ext[u] ?? 1, ext[v] ?? 1, 1)
  const ou = (size - (ext[u] ?? 0)) / 2 - (lo[u] ?? 0)
  const ov = (size - (ext[v] ?? 0)) / 2 + (hi[v] ?? 0)
  let d = ''
  for (const p of parts) {
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      const pts = [p.indices[t] ?? 0, p.indices[t + 1] ?? 0, p.indices[t + 2] ?? 0].map((i) => [(p.positions[i * 3 + u] ?? 0) + ou, ov - (p.positions[i * 3 + v] ?? 0)] as const)
      const [a, b, c] = pts as [readonly [number, number], readonly [number, number], readonly [number, number]]
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
      if (Math.abs(cross) < 1e-6) continue
      // One winding for every triangle, so overlapping faces fill instead of canceling.
      const [p1, p2] = cross > 0 ? [b, c] : [c, b]
      d += `M${a[0].toFixed(2)} ${a[1].toFixed(2)}L${p1[0].toFixed(2)} ${p1[1].toFixed(2)}L${p2[0].toFixed(2)} ${p2[1].toFixed(2)}Z`
    }
  }
  return (
    <svg className="silhouette" viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
