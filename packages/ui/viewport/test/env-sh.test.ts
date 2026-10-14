// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The environment's irradiance, projected from cube faces read back at once (stage.ts).
import { DataUtils, HalfFloatType, NoColorSpace, WebGLCoordinateSystem, type WebGLCubeRenderTarget, type WebGLRenderer } from 'three'
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js'
import { describe, expect, it } from 'vitest'
import { cubeFacesSH } from '../src/env-sh'

const SIZE = 8

function faces(texel: (face: number, i: number) => [number, number, number]): Uint16Array[] {
  return Array.from({ length: 6 }, (_, face) => {
    const px = new Uint16Array(SIZE * SIZE * 4)
    for (let i = 0; i < SIZE * SIZE; i++) {
      const [r, g, b] = texel(face, i)
      px.set([DataUtils.toHalfFloat(r), DataUtils.toHalfFloat(g), DataUtils.toHalfFloat(b), DataUtils.toHalfFloat(1)], i * 4)
    }
    return px
  })
}

describe('cube faces to spherical harmonics', () => {
  it('a uniform white room has only the constant term, 4 pi Y00', () => {
    const sh = cubeFacesSH(faces(() => [1, 1, 1]), SIZE)
    expect(sh).toHaveLength(9)
    expect(sh[0]!.x).toBeCloseTo(4 * Math.PI * 0.282095, 4)
    for (const c of sh.slice(1)) for (const v of c.toArray()) expect(Math.abs(v)).toBeLessThan(1e-6)
  })

  it('light from above shows in the y term only among the linear ones', () => {
    const sh = cubeFacesSH(faces((face) => (face === 2 ? [1, 1, 1] : [0, 0, 0])), SIZE)
    expect(sh[1]!.x).toBeGreaterThan(0.1)
    expect(Math.abs(sh[2]!.x)).toBeLessThan(1e-6)
    expect(Math.abs(sh[3]!.x)).toBeLessThan(1e-6)
  })

  it("matches three.js's light probe bake of the same faces", async () => {
    const data = faces((face, i) => [((face * 7 + i) % 13) / 13, ((face * 3 + i * 5) % 11) / 11, ((i * 2 + face) % 17) / 17])
    const reader = {
      isWebGLRenderer: true,
      coordinateSystem: WebGLCoordinateSystem,
      readRenderTargetPixelsAsync: async (_rt: unknown, _x: number, _y: number, _w: number, _h: number, out: Uint16Array, face: number) => {
        out.set(data[face]!)
        return out
      },
    }
    const target = { width: SIZE, texture: { type: HalfFloatType, colorSpace: NoColorSpace } }
    const probe = await LightProbeGenerator.fromCubeRenderTarget(reader as unknown as WebGLRenderer, target as unknown as WebGLCubeRenderTarget)
    const ours = cubeFacesSH(data, SIZE, -1)
    probe.sh.coefficients.forEach((c, j) => c.toArray().forEach((v, k) => expect(ours[j]!.toArray()[k]).toBeCloseTo(v, 9)))
  })
})
