// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's modeling skills end to end: a scripted model reply (no network) drives the whole pilot
// loop, approvals included, and the skill builds through the real geometry engine (the sx-geom
// command when built, else its web build). Skipped when neither is built.
import type { MeshPart, PilotEvent, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { evalGeom } from '../evals/geom'
import { createEvalEnv, type EvalHosts } from '../evals/harness'
import { parseInfo, toGeomMesh } from '../skills/geom_common/index'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'

const geom = evalGeom()
const P1S: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }

// The user's artwork: a pink heart with a cyan dot on it, 100 units square.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path fill="#ff79c6" d="M50 90 C20 70 0 50 10 25 C20 5 45 10 50 30 C55 10 80 5 90 25 C100 50 80 70 50 90 Z"/>' +
  '<circle fill="#8be9fd" cx="50" cy="45" r="9"/></svg>'

/** Runs one request with a scripted model, approving what the skill asks, and returns the events and the project. */
async function ask(prompt: string, script: ScriptStep[]) {
  const hosts = (): EvalHosts => ({ geom: geom! })
  const env = createEvalEnv({ client: createScriptedClient(script, { chunk: true }), machine: P1S, objects: [], hosts })
  const events: PilotEvent[] = []
  for await (const ev of env.pilot.run('e2e', prompt, { signal: new AbortController().signal, context: { project: 'e2e', machine: P1S, objects: [] } })) {
    events.push(ev)
    if (ev.type === 'approval_request') void env.pilot.resolveApproval(ev.request.id, { kind: 'approve' })
  }
  /** The result of the first call to a tool. */
  const result = (tool: string) => {
    const call = events.find((e): e is Extract<PilotEvent, { type: 'tool_call' }> => e.type === 'tool_call' && e.tool === tool)
    return events.find((e): e is Extract<PilotEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.callId === call?.callId)
  }
  return { env, events, result }
}

/** The engine's check of one mesh: closed, every edge shared by exactly two triangles, no flipped faces. */
async function manifold(parts: MeshPart[]) {
  const info = parseInfo((await geom!.run('info', { mesh: toGeomMesh(parts) })) as Record<string, unknown>)
  return { watertight: info.watertight, open: info.openEdges, nonManifold: info.nonManifoldEdges, flipped: info.flippedEdges }
}

describe.skipIf(!geom)('mimir modeling skills through the geometry engine', () => {
  it('"make a keychain from this SVG" ends with a manifold multi-part object, one filament slot per color', async () => {
    const { env, result } = await ask(`Make a keychain from this SVG: ${SVG}`, [
      {
        calls: [
          {
            name: 'make_model',
            args: {
              name: 'Heart keychain',
              parts: [
                { kind: 'box', name: 'tag', sizeMm: [44, 36, 3], color: 'SlicerX black' },
                { kind: 'mark', name: 'heart', mark: 'svg', svg: SVG, widthMm: 28, heightMm: 1.2, onPart: 0, offsetMm: [-4, 0], color: 'X pink', fillColors: { '#ff79c6': 'X pink', '#8be9fd': 'cyan' } },
              ],
              holes: [{ part: 0, diameterMm: 4, atMm: [17, 0] }],
            },
          },
        ],
      },
      { text: 'The heart keychain is on its own plate: a black tag with the pink heart and the cyan dot on top, and a 4 mm hole for the ring.' },
    ])
    const r = result('make_model')
    expect(r?.ok, JSON.stringify(r)).not.toBe(false)
    const out = r!.output as { objectId: string; slots: { slot: number; hex: string }[] }
    expect(out.slots.map((s) => s.hex)).toEqual(['#17181f', '#ff79c6', '#06b6d4'])
    // On the plate, as one object of several parts.
    expect(env.project.plates().at(-1)?.items.map((i) => i.objectId)).toContain(out.objectId)
    const parts = await env.project.objects().find((o) => o.id === out.objectId)!.mesh!()
    expect(parts.length).toBeGreaterThanOrEqual(3)
    // One slot per color, every color used by a part.
    expect([...new Set(parts.map((p) => p.slot))].sort()).toEqual([1, 2, 3])
    for (const p of parts) expect(await manifold([p]), p.name).toEqual({ watertight: true, open: 0, nonManifold: 0, flipped: 0 })
    // The hole went through the tag.
    const tag = parts.find((p) => p.slot === 1)!
    expect(Math.min(...Array.from(tag.positions).filter((_, i) => i % 3 === 2))).toBeCloseTo(0, 3)
  })

  it('a text_to_part request ends with a manifold part', async () => {
    const { env, result } = await ask('I need an L bracket, 40 mm legs, 20 mm wide, 4 mm thick, with a 4.5 mm screw hole in each leg.', [
      {
        calls: [
          {
            name: 'text_to_part',
            args: {
              name: 'L bracket 40 mm',
              solids: [{ type: 'l_bracket', legAMm: 40, legBMm: 40, widthMm: 20, thicknessMm: 4 }],
              holes: [
                { diameterMm: 4.5, atMm: [25, 10, 0], axis: 'z' },
                { diameterMm: 4.5, atMm: [0, 10, 25], axis: 'x' },
              ],
            },
          },
        ],
      },
      { text: 'The bracket is on its own plate, with a hole in each leg. Check the size before slicing.' },
    ])
    const r = result('text_to_part')
    expect(r?.ok, JSON.stringify(r)).not.toBe(false)
    const out = r!.output as { objectId: string; holesCut: boolean; shells: number; watertight: boolean }
    expect(out).toMatchObject({ holesCut: true, shells: 1, watertight: true })
    const parts = await env.project.objects().find((o) => o.id === out.objectId)!.mesh!()
    expect(await manifold(parts)).toEqual({ watertight: true, open: 0, nonManifold: 0, flipped: 0 })
  })

  it('text_to_part makes profiles boxes cannot: a rounded tab with a hole, joined to a base', async () => {
    const { env, result } = await ask('Make a 3 mm base plate 30 by 20 with a rounded hanging tab on top that has a 5 mm hole.', [
      {
        calls: [
          {
            name: 'text_to_part',
            args: {
              name: 'Hanger',
              solids: [{ type: 'plate', sizeMm: [30, 20, 3] }],
              profiles: [
                {
                  // A tab 20 wide with a round top, standing on the plate's top face and 3 mm thick in Y.
                  loops: [
                    { start: [5, 0], segments: [{ type: 'line', to: [25, 0] }, { type: 'line', to: [25, 10] }, { type: 'arc', to: [5, 10], through: [15, 20] }, { type: 'line', to: [5, 0] }] },
                    { type: 'circle', center: [15, 10], diameterMm: 5 },
                  ],
                  heightMm: 3,
                  atMm: [0, 8, 3],
                },
              ],
            },
          },
        ],
      },
      { text: 'The hanger is on its own plate.' },
    ])
    const r = result('text_to_part')
    expect(r?.ok, JSON.stringify(r)).not.toBe(false)
    const out = r!.output as { objectId: string; shells: number; volumeCm3: number }
    expect(out.shells).toBe(1)
    const parts = await env.project.objects().find((o) => o.id === out.objectId)!.mesh!()
    expect(await manifold(parts)).toEqual({ watertight: true, open: 0, nonManifold: 0, flipped: 0 })
    // Plate 1800 mm3, plus the tab: 20 by 10 and a half disc of radius 10, less the hole, 3 thick.
    const tab = (20 * 10 + (Math.PI * 100) / 2 - Math.PI * 2.5 * 2.5) * 3
    expect(out.volumeCm3).toBeCloseTo((1800 + tab) / 1000, 1)
  })

  it('says what is wrong with a profile in the engine\'s words', async () => {
    const { result } = await ask('Make a bow tie plate.', [
      { calls: [{ name: 'text_to_part', args: { name: 'Bow', profiles: [{ loops: [{ points: [[0, 0], [10, 10], [10, 0], [0, 10]] }], heightMm: 2 }] } }] },
      { text: 'That outline crosses itself.' },
    ])
    const r = result('text_to_part')
    expect(r?.ok).toBe(false)
    expect(r?.summary).toMatch(/^Profile 1: .*crosses/)
  })
})
