// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The engine's warning codes reach the slice summary (`warning_details`, beside the unchanged `warnings`) and the app's
// slice result, with the layer and object id the engine wrote. Run against a stand-in `sx` that answers with a fixed result.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSxSlicer } from '../src/sx'
import { createNodeSlicerHost } from '../src/slicerhost'
import { boxStl } from './helpers'

const OVERLAP = 'A overlaps B on layer 1; the overlap prints once, as part of B.'

/** A stand-in `sx` that prints `result` for `sx slice`. */
function fakeSx(result: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-fake-sx-'))
  writeFileSync(join(dir, 'out.json'), JSON.stringify(result))
  const bin = join(dir, 'sx')
  writeFileSync(bin, `#!/bin/sh\ncat "${join(dir, 'out.json')}"\n`)
  chmodSync(bin, 0o755)
  return bin
}

const engine = (warnings: unknown[]) => ({ layerCount: 2, stats: { timeS: 60, filamentMm: [100], filamentG: [0.3], toolChanges: 0 }, warnings, files: {} })

async function slice(bin: string) {
  const outDir = mkdtempSync(join(tmpdir(), 'slicerx-warning-details-'))
  const backend = createSxSlicer(bin)
  const modelPath = join(outDir, 'box.stl')
  writeFileSync(modelPath, boxStl(10, 10, 10))
  mkdirSync(join(outDir, 'o'), { recursive: true })
  return { outDir, backend, modelPath }
}

describe.skipIf(process.platform === 'win32')('the engine\'s warning codes', () => {
  const warnings = [
    { code: 'objects_overlap', message: OVERLAP, layer: 0, objectId: 'o1' },
    { code: 'brand_new_note', message: 'm' },
  ]

  it('reach the slice summary beside the unchanged messages', async () => {
    const { outDir, backend, modelPath } = await slice(fakeSx(engine(warnings)))
    const s = await backend.slice({ modelPath, config: {} as never, explicitConfig: {}, profileNames: [], overrides: {}, outDir: join(outDir, 'o'), emitGcode: false, trustedGcode: false })
    expect(s.warnings).toEqual([OVERLAP, 'm'])
    expect(s.warning_details).toEqual([
      { code: 'objects_overlap', message: OVERLAP, layer: 0, object_id: 'o1' },
      { code: 'brand_new_note', message: 'm' },
    ])
  })

  it('reach the app\'s slice result with the layer and object', async () => {
    const { outDir, backend } = await slice(fakeSx(engine(warnings)))
    const host = createNodeSlicerHost(backend, outDir)
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10])
    const mesh = await host.loadParts('box', [{ name: 'box', slot: 1, positions, indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) }])
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
    const r = await host.slice({ plate: { bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, objects: [{ id: 'o1', name: 'box', mesh: mesh.id, transform: T }] }, config: {} as never, options: { emitGcode: false } })
    expect(r.warnings).toEqual([
      { code: 'objects_overlap', message: OVERLAP, layer: 0, objectId: 'o1' },
      { code: 'brand_new_note', message: 'm' },
    ])
  })

  it('stay as unsupported settings when the engine writes no codes', async () => {
    const { outDir, backend } = await slice(fakeSx(engine([{ message: 'plain' }])))
    const host = createNodeSlicerHost(backend, outDir)
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10])
    const mesh = await host.loadParts('box', [{ name: 'box', slot: 1, positions, indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) }])
    const r = await host.slice({ plate: { bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, objects: [{ id: 'o1', name: 'box', mesh: mesh.id, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] }] }, config: {} as never, options: { emitGcode: false } })
    expect(r.warnings).toEqual([{ code: 'unsupported_setting', message: 'plain' }])
  })
})
