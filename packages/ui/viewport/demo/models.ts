// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The demo's reference model, built in code: a three color lamp (base, lathe
// turned shade, ball on top). Z up, millimeters, about 50k triangles.
export interface DecodedPart {
  name: string
  color: string
  positions: Float32Array
  indices: Uint32Array
}

// a surface of revolution around Z from a profile of [radius, z] points, capped at both ends
function lathe(name: string, color: string, profile: [number, number][], segments: number): DecodedPart {
  const pos: number[] = []
  const idx: number[] = []
  for (const [r, z] of profile) {
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2
      pos.push(r * Math.cos(a), r * Math.sin(a), z)
    }
  }
  for (let i = 0; i + 1 < profile.length; i++) {
    for (let s = 0; s < segments; s++) {
      const a = i * segments + s
      const b = i * segments + ((s + 1) % segments)
      idx.push(a, b, b + segments, a, b + segments, a + segments)
    }
  }
  const bottom = pos.length / 3
  pos.push(0, 0, profile[0]![1])
  const top = pos.length / 3
  pos.push(0, 0, profile[profile.length - 1]![1])
  const end = (profile.length - 1) * segments
  for (let s = 0; s < segments; s++) {
    const n = (s + 1) % segments
    idx.push(bottom, n, s, top, end + s, end + n)
  }
  return { name, color, positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

export function referenceModel(): DecodedPart[] {
  const seg = 160
  const base: [number, number][] = [
    [34, 0],
    [36, 2],
    [36, 6],
    [30, 9],
    [14, 12],
  ]
  const shade: [number, number][] = []
  for (let i = 0; i <= 96; i++) {
    const t = i / 96
    shade.push([12 + 16 * Math.sin(Math.PI * t) + 1.2 * Math.sin(t * Math.PI * 14), 12 + 60 * t])
  }
  const ball: [number, number][] = []
  for (let i = 0; i <= 48; i++) {
    const a = -Math.PI / 2 + (i / 48) * Math.PI
    ball.push([Math.max(0.01, 10 * Math.cos(a)), 82 + 10 * Math.sin(a)])
  }
  return [lathe('Base', '#bd93f9', base, seg), lathe('Shade', '#ff79c6', shade, seg), lathe('Ball', '#50fa7b', ball, seg)]
}
