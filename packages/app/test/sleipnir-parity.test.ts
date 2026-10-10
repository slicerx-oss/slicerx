// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app plans sleipnir's layers in the geometry engine; sx plans them itself when a request turns smart_layer on
// and sends no tops. Both run the same planner on the same plate mesh, so the tops must match. Runs where the
// engine (packages/geom/wasm/pkg) and sx (cargo build -p sx-cli --release) are built.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setGeomProvider } from '../src/geom/client'
import { planSmartLayers } from '../src/plate/smart-layer'
import { centerOnBed, dropToBed } from '../src/plate/transform'
import { liveEngine, wasmGeom } from './geom-engine'

const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(__dirname, '../../../target/release/sx')
const models = resolve(__dirname, '../../core/bench/models')
const config = { nozzle_diameter: [0.4], smart_layer_min_height: 0.15, smart_layer_max_height: 0.2, initial_layer_print_height: 0.2 }

function readStl(path: string) {
  const b = readFileSync(path)
  const n = b.readUInt32LE(80)
  const positions = new Float32Array(n * 9)
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) positions[t * 9 + k] = b.readFloatLE(84 + t * 50 + 12 + k * 4)
  return { positions, indices: Uint32Array.from({ length: n * 3 }, (_, i) => i) }
}

/** A binary STL of a box `w` x `d` x `h` mm. */
function boxStl(path: string, w: number, d: number, h: number) {
  const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]]
  const tris = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const b = Buffer.alloc(84 + tris.length * 50)
  b.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => t.forEach((vi, k) => v[vi]!.forEach((c, j) => b.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + j * 4))))
  writeFileSync(path, b)
}

describe.skipIf(!liveEngine || !existsSync(sxBin))('sleipnir in the app and in sx', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleipnir-parity-'))
  boxStl(join(dir, 'box-12mm.stl'), 20, 20, 12)

  async function both(file: string) {
    setGeomProvider(await wasmGeom())
    const part = readStl(file)
    const bed = { widthMm: 256, depthMm: 256, heightMm: 256 }
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const transform = centerOnBed([part], dropToBed([part], id), bed as never)
    const app = await planSmartLayers([{ parts: [part], transform } as never], config, 'quality')
    const req = { plate: { objects: [{ mesh: file, transform }] }, config: { smart_layer: 'quality', ...config }, options: { emitGcode: false } }
    writeFileSync(join(dir, 'req.json'), JSON.stringify(req))
    const sx = (JSON.parse(execFileSync(sxBin, ['slice', '--request', join(dir, 'req.json'), '--out-dir', dir], { maxBuffer: 1 << 28 }).toString()) as { layerZ: number[] }).layerZ
    return { app: app ?? [], sx }
  }

  for (const [name, file, top] of [
    ['x-mark', join(models, 'x-mark.stl'), 85.5],
    ['showcase X', join(models, 'x-mark-showcase.stl'), 86],
    ['12 mm box', join(dir, 'box-12mm.stl'), 12],
  ] as const) {
    it(`plans the same tops for the ${name}, ending on its top`, async () => {
      const { app, sx } = await both(file)
      expect(sx.length).toBe(app.length)
      for (let i = 0; i < app.length; i++) expect(Math.abs(app[i]! - sx[i]!), `layer ${i}`).toBeLessThan(1e-5)
      expect(app.at(-1)).toBeCloseTo(top, 6)
      expect(sx.at(-1)).toBeCloseTo(top, 4)
      const thinnest = Math.min(...app.slice(1).map((t, i) => t - app[i]!))
      expect(thinnest).toBeGreaterThanOrEqual(0.15 - 1e-6)
    }, 120_000)
  }
})
