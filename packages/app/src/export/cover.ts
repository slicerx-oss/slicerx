// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cover picture for a Vault upload, drawn from the model's own triangles: a
// three-quarter view from above, flat shaded in the filament colors, on the
// Nocturne ground. Pure code with a z-buffer, so it works without the viewport,
// in a worker and in Node.

export interface CoverMesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
  /** #rrggbb */
  color: string
  /** 4x4 column-major placement, mm. */
  transform?: ArrayLike<number>
}

export interface CoverImage {
  width: number
  height: number
  rgba: Uint8ClampedArray
}

type V3 = [number, number, number]

function hex(c: string): V3 {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim())
  const n = m ? parseInt(m[1]!, 16) : 0xbd93f9
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function place(t: ArrayLike<number> | undefined, x: number, y: number, z: number): V3 {
  if (!t) return [x, y, z]
  return [
    (t[0] ?? 1) * x + (t[4] ?? 0) * y + (t[8] ?? 0) * z + (t[12] ?? 0),
    (t[1] ?? 0) * x + (t[5] ?? 1) * y + (t[9] ?? 0) * z + (t[13] ?? 0),
    (t[2] ?? 0) * x + (t[6] ?? 0) * y + (t[10] ?? 1) * z + (t[14] ?? 0),
  ]
}

/** Renders the meshes at width by height. Empty input gives just the ground. */
export function renderCover(meshes: readonly CoverMesh[], width = 800, height = 600): CoverImage {
  const rgba = new Uint8ClampedArray(width * height * 4)
  // Ground: a soft vertical gradient from ink-2 to ink-0.
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1)
    const r = 0x34 + (0x28 - 0x34) * t
    const g = 0x37 + (0x2a - 0x37) * t
    const b = 0x46 + (0x36 - 0x46) * t
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      rgba[o + 3] = 255
    }
  }
  // View: turn 35 degrees about Z, then tilt so the camera looks down at 30 degrees.
  const yaw = (-35 * Math.PI) / 180
  const pitch = (60 * Math.PI) / 180
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const view = (p: V3): V3 => {
    const x = p[0] * cy - p[1] * sy
    const y = p[0] * sy + p[1] * cy
    // screen x, screen y (up), depth (toward the camera is larger)
    return [x, y * cp + p[2] * sp, -y * sp + p[2] * cp]
  }
  const tris: { a: V3; b: V3; c: V3; color: V3 }[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const m of meshes) {
    const col = hex(m.color)
    const pts: V3[] = []
    for (let i = 0; i + 2 < m.positions.length; i += 3) {
      const v = view(place(m.transform, m.positions[i] ?? 0, m.positions[i + 1] ?? 0, m.positions[i + 2] ?? 0))
      pts.push(v)
      if (v[0] < minX) minX = v[0]
      if (v[0] > maxX) maxX = v[0]
      if (v[1] < minY) minY = v[1]
      if (v[1] > maxY) maxY = v[1]
    }
    for (let i = 0; i + 2 < m.indices.length; i += 3) {
      const a = pts[m.indices[i] ?? 0]
      const b = pts[m.indices[i + 1] ?? 0]
      const c = pts[m.indices[i + 2] ?? 0]
      if (a && b && c) tris.push({ a, b, c, color: col })
    }
  }
  if (tris.length === 0 || !Number.isFinite(minX)) return { width, height, rgba }
  const margin = 0.14
  const scale = Math.min((width * (1 - 2 * margin)) / Math.max(1e-6, maxX - minX), (height * (1 - 2 * margin)) / Math.max(1e-6, maxY - minY))
  const ox = width / 2 - ((minX + maxX) / 2) * scale
  const oy = height / 2 + ((minY + maxY) / 2) * scale
  const sx = (v: V3): V3 => [ox + v[0] * scale, oy - v[1] * scale, v[2]]
  const depth = new Float32Array(width * height).fill(-Infinity)
  const light: V3 = (() => {
    const l: V3 = [-0.35, 0.45, 0.82]
    const n = Math.hypot(...l)
    return [l[0] / n, l[1] / n, l[2] / n]
  })()
  for (const t of tris) {
    const a = sx(t.a)
    const b = sx(t.b)
    const c = sx(t.c)
    // Normal in view space; screen y points down, so flip it back.
    const u: V3 = [b[0] - a[0], -(b[1] - a[1]), b[2] - a[2]]
    const w: V3 = [c[0] - a[0], -(c[1] - a[1]), c[2] - a[2]]
    let n: V3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const len = Math.hypot(...n) || 1
    n = [n[0] / len, n[1] / len, n[2] / len]
    // Two-sided: a face turned away is lit as if it faced the camera.
    if (n[2] < 0) n = [-n[0], -n[1], -n[2]]
    const lambert = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2])
    const shade = 0.38 + 0.62 * lambert
    const r = Math.min(255, t.color[0] * shade + 12)
    const g = Math.min(255, t.color[1] * shade + 12)
    const bl = Math.min(255, t.color[2] * shade + 14)
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])))
    const x1 = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])))
    const y1 = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (Math.abs(area) < 1e-9) continue
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5
        const py = y + 0.5
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area
        const w2 = 1 - w0 - w1
        if (w0 < 0 || w1 < 0 || w2 < 0) continue
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2]
        const i = y * width + x
        if (z <= (depth[i] ?? -Infinity)) continue
        depth[i] = z
        const o = i * 4
        rgba[o] = r
        rgba[o + 1] = g
        rgba[o + 2] = bl
        rgba[o + 3] = 255
      }
    }
  }
  return { width, height, rgba }
}

/** Triangles from a binary or ASCII STL, for a cover. Null when the bytes are not an STL. */
export function stlMesh(bytes: Uint8Array): { positions: Float32Array; indices: Uint32Array } | null {
  if (bytes.length >= 84) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const n = dv.getUint32(80, true)
    if (84 + n * 50 === bytes.length && n > 0) {
      const positions = new Float32Array(n * 9)
      for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) positions[t * 9 + k] = dv.getFloat32(84 + t * 50 + 12 + k * 4, true)
      return { positions, indices: Uint32Array.from({ length: n * 3 }, (_, i) => i) }
    }
  }
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 << 20)))
  if (!/^\s*solid/.test(text)) return null
  const nums: number[] = []
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(Number(m[1]), Number(m[2]), Number(m[3]))
  if (nums.length < 9 || nums.some((v) => !Number.isFinite(v))) return null
  const count = Math.floor(nums.length / 9) * 9
  return { positions: Float32Array.from(nums.slice(0, count)), indices: Uint32Array.from({ length: count / 3 }, (_, i) => i) }
}
