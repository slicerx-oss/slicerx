// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Spherical-harmonic irradiance of a small cube render, for the toolpaths' ambient light (stage.ts). The faces are read
// back in one go, right after the cube is drawn, so the projection itself never touches the GPU.
import { DataUtils, SphericalHarmonics3, Vector3 } from 'three'

/**
 * Projects six square faces of linear RGBA texels (half floats, in three.js's cube face order +x, -x, +y, -y, +z, -z)
 * onto the nine order 2 spherical harmonics. `flip` is -1 for WebGL's cube layout, 1 for WebGPU's. Each texel is
 * weighted by the solid angle it covers, and the sum is scaled to the whole sphere.
 */
export function cubeFacesSH(faces: readonly Uint16Array[], size: number, flip: 1 | -1 = -1): Vector3[] {
  const out = Array.from({ length: 9 }, () => new Vector3())
  const basis = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const coord = new Vector3()
  const dir = new Vector3()
  const texel = 2 / size
  let total = 0
  faces.forEach((px, face) => {
    for (let i = 0; i < size * size; i++) {
      const r = DataUtils.fromHalfFloat(px[i * 4]!)
      const g = DataUtils.fromHalfFloat(px[i * 4 + 1]!)
      const b = DataUtils.fromHalfFloat(px[i * 4 + 2]!)
      // the texel's center on the unit cube
      const col = (1 - ((i % size) + 0.5) * texel) * flip
      const row = 1 - (Math.floor(i / size) + 0.5) * texel
      if (face === 0) coord.set(-flip, row, col * flip)
      else if (face === 1) coord.set(flip, row, -col * flip)
      else if (face === 2) coord.set(col, 1, -row)
      else if (face === 3) coord.set(col, -1, row)
      else if (face === 4) coord.set(col, row, 1)
      else coord.set(-col, row, -1)
      const len2 = coord.lengthSq()
      const weight = 4 / (Math.sqrt(len2) * len2)
      total += weight
      SphericalHarmonics3.getBasisAt(dir.copy(coord).normalize(), basis)
      for (let j = 0; j < 9; j++) {
        const k = basis[j]! * weight
        out[j]!.x += k * r
        out[j]!.y += k * g
        out[j]!.z += k * b
      }
    }
  })
  const norm = (4 * Math.PI) / total
  for (const c of out) c.multiplyScalar(norm)
  return out
}
