// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, createEvalSlicer } from '../evals/harness'
import { evalGeom } from '../evals/geom'
import { runScenario } from '../evals/runner'
import { SCENARIOS } from '../evals/skills/f'
import type { ProjectExportHost } from '../src/hosts'
import { createScriptedClient } from '../src/provider/scripted'
import type { PilotTool, ToolContext } from '../src/tool'
import { pickPreset, resolveColor } from '../skills/make_model/colors'
import { SLICERX_X_PATH, pathRings, placeRing } from '../skills/make_model/marks'
import { createMakeModel, planSlots } from '../skills/make_model/index'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const geom = evalGeom()
const NO_GEOM = 'sx-geom is not built (cargo build -p sx-geom), so geometry cases are skipped'

function setup(exportHost?: ProjectExportHost) {
  const env = createEvalEnv({ client: createScriptedClient([]), machine: MACHINE, objects: [] })
  const raw = createMakeModel() as unknown as PilotTool<Record<string, unknown>>
  // The runtime parses input (and applies defaults) before run.
  const tool: PilotTool<Record<string, unknown>> = { ...raw, run: (i, c) => raw.run(raw.input.parse(i) as Record<string, unknown>, c) }
  const ctx = (): ToolContext => ({
    host: { printers: env.sim, slicer: createEvalSlicer(() => env.project), ...(geom ? { geom } : {}), ...(exportHost ? { projectExport: exportHost } : {}) },
    sessionId: 's1',
    callId: 'c1',
    signal: new AbortController().signal,
    context: { machine: MACHINE },
    today: '2026-09-30',
    project: env.project,
    kb: env.kb,
    progress: () => undefined,
  })
  return { env, tool, ctx }
}

const LOGO = {
  name: 'SlicerX logo',
  parts: [
    { kind: 'box', sizeMm: [60, 60, 2], color: 'SlicerX black' },
    { kind: 'mark', mark: 'slicerx-x', widthMm: 40, heightMm: 1, onPart: 0, color: 'X pink' },
  ],
}

describe('make_model scenarios replay', () => {
  it.skipIf(!geom).each(SCENARIOS.map((s) => [s.id, s] as const))('%s passes', async (_id, s) => {
    const rec = await runScenario(s, { mode: 'replay', model: 'scripted', run: 1 })
    expect({ pass: rec.score.pass, notes: rec.score.notes }).toMatchObject({ pass: true })
  })
})

describe('colors', () => {
  it('resolves brand names, plain names and hex', () => {
    expect(resolveColor('SlicerX black')).toEqual({ hex: '#17181f', label: 'SlicerX black' })
    expect(resolveColor('x pink')?.hex).toBe('#ff79c6')
    expect(resolveColor('  X   Pink ')?.hex).toBe('#ff79c6')
    expect(resolveColor('blue')?.hex).toBe('#3b82f6')
    expect(resolveColor('#FF79C6')?.hex).toBe('#ff79c6')
    expect(resolveColor('vibrant flurbo')).toBeNull()
  })

  it('picks a filament product for the material, the maker basic line on Bambu Lab printers', () => {
    expect(pickPreset('PLA', 'bambu_p1s')?.family).toMatch(/Bambu PLA Basic/)
    expect(pickPreset('PLA', 'prusa_mk4s')?.family).toMatch(/^Generic/)
    expect(pickPreset('NOSUCH', undefined)).toBeNull()
  })

  it('gives each distinct color one slot in order of first use', () => {
    const p = planSlots([...LOGO.parts, { kind: 'box', sizeMm: [5, 5, 1], color: '#ff79c6' }] as never, 'PLA', 'bambu_p1s')
    expect(p.slots.map((s) => `${s.slot}:${s.color.hex}`)).toEqual(['1:#17181f', '2:#ff79c6'])
    expect(p.slotOf).toEqual([1, 2, 2])
    expect(p.unknown).toEqual([])
  })
})

describe('marks', () => {
  it('reads the SlicerX X as one closed ring of 12 points, counterclockwise after the flip', () => {
    const rings = pathRings(SLICERX_X_PATH)
    expect(rings).toHaveLength(1)
    expect(rings?.[0]).toHaveLength(12)
    const placed = placeRing(rings![0]!, 40)
    expect(placed.widthMm).toBe(40)
    expect(placed.heightMm).toBeCloseTo((24 / 23) * 40, 3)
    const area = placed.points.reduce((a, p, i) => a + p[0] * placed.points[(i + 1) % placed.points.length]![1] - placed.points[(i + 1) % placed.points.length]![0] * p[1], 0)
    expect(area).toBeGreaterThan(0)
  })

  it('refuses curves so the geometry engine handles them', () => {
    expect(pathRings('M0 0C1 1 2 2 3 3z')).toBeNull()
  })
})

describe.skipIf(!geom)(`the tool with geometry (${NO_GEOM})`, () => {
  it('builds the logo, adds it on its own plate and reports grams per color', async () => {
    const { env, tool, ctx } = setup()
    const out = await tool.run(LOGO, ctx())
    expect(out.ok).not.toBe(false)
    const o = out.output as { objectId: string; sizeMm: number[]; slots: { slot: number; hex: string; grams: number; preset: string }[]; slice: { timeS: number } }
    expect(o.sizeMm[0]).toBeCloseTo(60, 1)
    expect(o.sizeMm[2]).toBeCloseTo(3, 2)
    expect(o.slots.map((s) => s.hex)).toEqual(['#17181f', '#ff79c6'])
    expect(o.slots.every((s) => s.grams > 0)).toBe(true)
    expect(o.slots[0]!.grams).toBeGreaterThan(o.slots[1]!.grams)
    expect(o.slots[0]!.preset).toMatch(/Bambu PLA Basic/)
    expect(o.slice.timeS).toBeGreaterThan(0)
    const parts = await env.project.objects().find((x) => x.id === o.objectId)!.mesh!()
    expect(parts.map((p) => p.slot)).toEqual([1, 2])
    expect(env.project.plates().at(-1)?.items[0]?.objectId).toBe(o.objectId)
  })

  it('draws the X where it says: 40 mm wide in x, upright in y, centered on the plate', async () => {
    const { env, tool, ctx } = setup()
    const out = await tool.run({ ...LOGO, slice: false }, ctx())
    const id = (out.output as { objectId: string }).objectId
    const x = (await env.project.objects().find((o) => o.id === id)!.mesh!())[1]!
    const xs = Array.from({ length: x.positions.length / 3 }, (_, i) => x.positions[i * 3]!)
    const ys = Array.from({ length: x.positions.length / 3 }, (_, i) => x.positions[i * 3 + 1]!)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 2)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo((24 / 23) * 40, 2)
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(30, 2)
    expect((Math.max(...ys) + Math.min(...ys)) / 2).toBeCloseTo(30, 2)
  })

  it('puts the mark on top of the plate', async () => {
    const { env, tool, ctx } = setup()
    const out = await tool.run(LOGO, ctx())
    const id = (out.output as { objectId: string }).objectId
    const [plate, x] = await env.project.objects().find((o) => o.id === id)!.mesh!()
    const zs = (p: { positions: Float32Array }) => Array.from({ length: p.positions.length / 3 }, (_, i) => p.positions[i * 3 + 2]!)
    expect(Math.min(...zs(plate!))).toBeCloseTo(0, 3)
    expect(Math.max(...zs(plate!))).toBeCloseTo(2, 3)
    expect(Math.min(...zs(x!))).toBeCloseTo(2, 3)
    expect(Math.max(...zs(x!))).toBeCloseTo(3, 3)
  })

  it('cuts a hole through the tag', async () => {
    const { env, tool, ctx } = setup()
    const tag = { name: 'Tag', parts: [{ kind: 'box', sizeMm: [40, 18, 3], color: 'black' }], slice: false }
    const whole = await tool.run(tag, ctx())
    const holed = await tool.run({ ...tag, name: 'Tag holed', holes: [{ part: 0, diameterMm: 4, atMm: [15, 0] }] }, ctx())
    expect(holed.ok).not.toBe(false)
    const vol = async (id: string) => {
      const info = await geom!.run('info', { mesh: { positions: Array.from((await env.project.objects().find((o) => o.id === id)!.mesh!())[0]!.positions), indices: Array.from((await env.project.objects().find((o) => o.id === id)!.mesh!())[0]!.indices) } })
      return (info as { volumeMm3: number }).volumeMm3
    }
    const v0 = await vol((whole.output as { objectId: string }).objectId)
    const v1 = await vol((holed.output as { objectId: string }).objectId)
    expect(Math.abs(v0 - v1 - Math.PI * 4 * 3)).toBeLessThan(0.6)
  })

  it('stands raised text on the plate in its own color', async () => {
    const { env, tool, ctx } = setup()
    const out = await tool.run({ name: 'Plate', parts: [{ kind: 'box', sizeMm: [100, 30, 3], color: 'black' }, { kind: 'text', text: 'SLICERX', sizeMm: 14, heightMm: 1, onPart: 0, color: 'X pink' }], slice: false }, ctx())
    expect(out.ok).not.toBe(false)
    const id = (out.output as { objectId: string }).objectId
    const [, t] = await env.project.objects().find((o) => o.id === id)!.mesh!()
    const at = (k: number) => Array.from({ length: t!.positions.length / 3 }, (_, i) => t!.positions[i * 3 + k]!)
    expect(t!.slot).toBe(2)
    expect(Math.min(...at(2))).toBeCloseTo(3, 3)
    expect(Math.max(...at(2))).toBeCloseTo(4, 3)
    expect((Math.max(...at(0)) + Math.min(...at(0))) / 2).toBeCloseTo(50, 1)
    expect((Math.max(...at(1)) + Math.min(...at(1))) / 2).toBeCloseTo(15, 1)
    expect(Math.max(...at(1)) - Math.min(...at(1))).toBeLessThan(30)
  })

  it('says when a hole misses the part or a color is unknown', async () => {
    const { tool, ctx } = setup()
    const miss = await tool.run({ name: 'Tag', parts: [{ kind: 'box', sizeMm: [40, 18, 3], color: 'black' }], holes: [{ part: 0, diameterMm: 4, atMm: [60, 0] }], slice: false }, ctx())
    expect(miss.ok).toBe(false)
    expect(miss.summary).toMatch(/misses/)
    const bad = await tool.run({ name: 'Tag', parts: [{ kind: 'box', sizeMm: [40, 18, 3], color: 'vibrant flurbo' }] }, ctx())
    expect(bad.ok).toBe(false)
    expect(bad.summary).toMatch(/flurbo/)
  })

  it('takes an SVG with two fills and maps each fill to a color', async () => {
    const { env, tool, ctx } = setup()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect x="0" y="0" width="10" height="10" fill="#ff0000"/><rect x="10" y="0" width="10" height="10" fill="#0000ff"/></svg>'
    const out = await tool.run({ name: 'Flag', parts: [{ kind: 'mark', mark: 'svg', svg, widthMm: 40, heightMm: 1, fillColors: { '#ff0000': 'X pink', '#0000ff': 'blue' } }], slice: false }, ctx())
    expect(out.ok).not.toBe(false)
    const id = (out.output as { objectId: string }).objectId
    const parts = await env.project.objects().find((o) => o.id === id)!.mesh!()
    expect(parts).toHaveLength(2)
    const slots = (out.output as { slots: { hex: string }[] }).slots.map((s) => s.hex)
    expect(slots).toEqual(['#ff79c6', '#3b82f6'])
    expect(parts.map((p) => p.slot).sort()).toEqual([1, 2])
  })

  it('exports a 3MF through the host when asked and reports a canceled dialog', async () => {
    const calls: unknown[] = []
    const { tool, ctx } = setup({
      async export3mf(input) {
        calls.push(input)
        return { fileName: 'logo.3mf', bytes: 1234 }
      },
    })
    const out = await tool.run({ ...LOGO, export3mf: true }, ctx())
    expect((out.output as { file: { fileName: string } }).file.fileName).toBe('logo.3mf')
    expect(calls).toHaveLength(1)
    expect((calls[0] as { slots: { color: string }[] }).slots.map((s) => s.color)).toEqual(['#17181f', '#ff79c6'])
    const none = setup({ export3mf: async () => null })
    const out2 = await none.tool.run({ ...LOGO, export3mf: true }, none.ctx())
    expect((out2.output as { file: { canceled: boolean } }).file.canceled).toBe(true)
  })
})
