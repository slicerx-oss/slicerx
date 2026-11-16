// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An exact design whose part's solid grows past the largest solid text a part keeps: the step that grew it is refused
// with the size and the limit in the reply, and the design is unchanged. One just under the limit goes through. A
// client starting an exact design where bodies go between calls as text reads back how detailed its part may grow.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SOLID_TEXT, clearReplayCache, solidTooBig, tooBigOf, unstopped, type StepParams } from '@slicerx/cad-history'
import { Designs } from '../src/design'
import { geomEngine } from '../src/geom'
import { connect, data, text } from './helpers'

const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }
const box: StepParams = { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } }
const hole = { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }], label: 'Hole 4 mm' } as StepParams
const dirs: string[] = []

/** The design host on an engine whose kernel answers a cut with a solid text `chars` long. */
function host(chars: number) {
  const outDir = mkdtempSync(join(tmpdir(), 'design-solid-cap-'))
  dirs.push(outDir)
  const engine = async (op: string) => {
    if (op === 'brep.count') return { bodies: 0 }
    if (op === 'brep.tessellate') return { ...tri, faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op === 'brep.subtract') return { body: 1, bodySmb: 'x'.repeat(chars) }
    if (op.startsWith('brep.')) return { body: 1, bodySmb: `${op}-solid` }
    throw new Error(`unexpected ${op}`)
  }
  return new Designs({ engine, policy: { outDir, allowDirs: undefined, allowUrls: false } })
}

afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

it('takes a cut whose solid is at the limit', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = host(MAX_SOLID_TEXT)
  const d = await h.create('Plate', [], undefined, undefined, { exact: true })
  await h.add(d, 0, box)
  await h.add(d, 0, hole)
  expect(d.history.steps).toHaveLength(2)
  expect(d.status.map((s) => s.state)).toEqual(['done', 'done'])
})

it('refuses a cut whose solid passes the limit, with the size and the limit, and keeps the design as it was', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = host(MAX_SOLID_TEXT + 1)
  const d = await h.create('Plate', [], undefined, undefined, { exact: true })
  await h.add(d, 0, box)
  await expect(h.add(d, 0, hole)).rejects.toThrow(`Exact replay stopped: ${unstopped(solidTooBig(MAX_SOLID_TEXT + 1, true))}. The design is unchanged.`)
  expect(d.history.steps).toHaveLength(1)
})

// sx-geom refusing a body too big for it: the size and limit ride on the error, which the replay turns into the same
// sentence; an older sx-geom's error has its sentence alone
it.each([
  [{ error: 'brep: the body is too big for the kernel', tooBig: { size: 9_000_000, limit: 5_000_000 } }, { size: 9_000_000, limit: 5_000_000 }],
  [{ error: 'brep: the body is too big for the kernel' }, undefined],
] as const)("the engine's error carries its size and limit when it gives them (%#)", async (reply, tooBig) => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-geom-too-big-'))
  dirs.push(dir)
  const refusing = join(dir, 'refusing.cjs')
  writeFileSync(refusing, `process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(JSON.stringify(reply))}); process.exit(1) });`)
  const e = await geomEngine(process.execPath, 5000)(refusing, {}).catch((x: unknown) => x)
  expect((e as Error).message).toBe(reply.error)
  expect(tooBigOf(e)).toEqual(tooBig)
})

describe('how detailed an exact part may grow', () => {
  /** An engine with the exact kernel that sends bodies back as text and counts them (exact.ops `maxSolid`). */
  const counting = async (op: string) => {
    if (op === 'brep.count') return { bodies: 0 }
    if (op === 'exact.ops') return { ops: ['sketch.loft'], maxSolid: { edges: 3300, controlPoints: 178000 } }
    throw new Error(`unexpected ${op}`)
  }

  it('is in the reply of a client starting an exact design, and not of a mesh one', async () => {
    vi.stubEnv('SX_BREP_DEV', '1')
    const h = await connect({ geomEngine: counting })
    const r = await h.call('slicerx_design_new', { name: 'Plate', exact: true })
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<{ output: { exact: boolean; solidLimits?: unknown } }>(r).output).toMatchObject({ exact: true, solidLimits: { textChars: MAX_SOLID_TEXT, edges: 3300, controlPoints: 178000 } })
    const mesh = await h.call('slicerx_design_new', { name: 'Mesh' })
    expect(data<{ output: Record<string, unknown> }>(mesh).output).not.toHaveProperty('solidLimits')
  })

  it('is the text limit alone from an engine that counts nothing, and none where bodies are held', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'design-solid-limits-'))
    dirs.push(outDir)
    const policy = { outDir, allowDirs: undefined, allowUrls: false }
    const older = async (op: string) => (op === 'exact.ops' ? { ops: [] } : { bodies: 0 })
    expect(await new Designs({ engine: older, policy }).solidLimits()).toEqual({ textChars: MAX_SOLID_TEXT })
    expect(await new Designs({ engine: counting, keepsBodies: async () => true, policy }).solidLimits()).toBeUndefined()
  })
})
