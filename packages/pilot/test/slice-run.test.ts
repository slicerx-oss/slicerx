// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The slice skill records its slice in the chat's print run: the time, filament, cost and warnings of the run's plate
// (the first plate sliced when that one was not), with the plate's fingerprint from before the slice. Slicing again
// replaces the slice and clears stale.
import { DEFAULT_POLICY, type ApprovalHost, type CommandSpec, type LlmTransport, type PilotEvent, type Plate, type PrinterHost, type SliceResult } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createSlice } from '../skills/slice/index'
import { createPilot, createScriptedClient, createShared, DEFAULT_CONFIG, type CommandToolContext, type PilotProject, type PilotTool, type PrintRunHost, type ScriptStep } from '../src/index'
import { commandTools } from '../src/tools/misc'

const printers = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost

function fakeSlicer(stats: Partial<Pick<SliceResult, 'stats' | 'warnings'>>[]) {
  let n = 0
  return {
    async slice(): Promise<SliceResult> {
      const s = stats[Math.min(n, stats.length - 1)] ?? {}
      n++
      return {
        id: `sl_${n}`,
        engine: 'native',
        layerCount: 50,
        layerZ: new Float32Array(),
        layerTimeS: new Float32Array(),
        stats: { timeS: 1800, filamentMm: [1000], filamentG: [12], cost: 0.3, toolChanges: 0 },
        stageMicros: {},
        wallMs: 5,
        warnings: [],
        ...s,
      } as unknown as SliceResult
    },
  }
}

function project(plates: number[]): PilotProject {
  return {
    name: 'Clip',
    machine: () => undefined,
    objects: () => [],
    plates: () => plates.map((index) => ({ index, items: [] })),
    setPlates: () => undefined,
    overrides: () => ({}),
    setOverrides: () => undefined,
    plate: async () => ({ objects: [] }) as unknown as Plate,
    config: () => ({}),
  } as unknown as PilotProject
}

/** Plate 1's fingerprint is `fp`; another plate's carries its number, so a test sees which plate was read. */
function fakeHost(fp: string): PrintRunHost & { fp: string } {
  const h = { fp, fingerprint: (plate?: number) => (plate === undefined || plate === 1 ? h.fp : `${h.fp}:p${plate}`) }
  return h
}

function pilot(steps: ScriptStep[], printRun: PrintRunHost, slicer: ReturnType<typeof fakeSlicer>, plates = [1], extra: PilotTool<never>[] = []) {
  return createPilot({
    host: { printers, approvals: {} as ApprovalHost, llm: {} as LlmTransport, slicer: slicer as never },
    config: DEFAULT_CONFIG,
    policy: DEFAULT_POLICY,
    client: createScriptedClient(steps, { chunk: false }),
    builtins: false,
    project: () => project(plates),
    tools: [createSlice(createShared()), ...extra] as never[],
    printRun,
  })
}

async function collect(it: AsyncIterable<PilotEvent>): Promise<PilotEvent[]> {
  const out: PilotEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('the slice in the print run', () => {
  it('slicing records time, grams, cost and warnings in the run', async () => {
    const slicer = fakeSlicer([{ stats: { timeS: 3723.4, filamentMm: [4000, 900], filamentG: [10.04, 2.5], cost: 0.456, toolChanges: 2 }, warnings: [{ code: 'thin_wall', message: 'A wall on Clip is thinner than the nozzle.' }] as SliceResult['warnings'] }])
    const p = pilot([{ calls: [{ name: 'slice', args: {} }] }, { text: 'Done.' }], fakeHost('fp1'), slicer)
    const events = await collect(p.run('s', 'slice it'))
    const want = { sliceId: 'sl_1', plate: 1, at: expect.any(String), timeS: 3723, grams: 12.5, cost: 0.46, warnings: ['A wall on Clip is thinner than the nozzle.'], fingerprint: 'fp1', stale: false }
    expect(p.printRun!('s')!.slice).toEqual(want)
    // the card hears of it in the same run
    const runs = events.flatMap((e) => (e.type === 'print_run' ? [e.run] : []))
    expect(runs.at(-1)?.slice).toEqual(want)
    expect(Number.isNaN(Date.parse(p.printRun!('s')!.slice!.at))).toBe(false)
  })

  it('records the first plate sliced when the run plate was not sliced', async () => {
    const p = pilot([{ calls: [{ name: 'slice', args: { plates: [2, 3] } }] }, { text: 'Done.' }], fakeHost('fp1'), fakeSlicer([{}]), [1, 2, 3])
    await collect(p.run('s', 'slice plates 2 and 3'))
    const run = p.printRun!('s')!
    expect(run.plate).toBe(2)
    // the fingerprint is plate 2's own, so it stays fresh whichever plate the app shows
    expect(run.slice).toMatchObject({ sliceId: 'sl_1', plate: 2, fingerprint: 'fp1:p2', stale: false })
  })

  it('a second slice replaces the first and clears stale', async () => {
    const h = fakeHost('fp1')
    const slicer = fakeSlicer([{}, { stats: { timeS: 600, filamentMm: [300], filamentG: [3], cost: 0.08, toolChanges: 0 } }])
    const p = pilot([{ calls: [{ name: 'slice', args: {} }] }, { text: 'Done.' }, { calls: [{ name: 'slice', args: {} }] }, { text: 'Done.' }], h, slicer)
    await collect(p.run('s', 'slice it'))
    expect(p.printRun!('s')!.slice).toMatchObject({ sliceId: 'sl_1', timeS: 1800, stale: false })
    // the plate changed after slicing
    h.fp = 'fp2'
    expect(p.printRun!('s')!.slice!.stale).toBe(true)
    await collect(p.run('s', 'slice it again'))
    expect(p.printRun!('s')!.slice).toMatchObject({ sliceId: 'sl_2', timeS: 600, grams: 3, cost: 0.08, warnings: [], fingerprint: 'fp2', stale: false })
  })

  it('an app command gets only update and fingerprint of the run', async () => {
    let seen: CommandToolContext | undefined
    const command: CommandSpec = {
      id: 'slice',
      title: 'Slice the plate',
      section: 'slice',
      tool: { permission: 'slice' },
      run: (_input?: unknown, cx?: CommandToolContext) => {
        seen = cx
        cx?.run?.update({ printerId: 'p7' })
        return { fingerprint: cx?.run?.fingerprint(2) }
      },
    }
    const p = pilot([{ calls: [{ name: 'app.slice', args: {} }] }, { text: 'Done.' }], fakeHost('fp1'), fakeSlicer([{}]), [1], commandTools([command]))
    const events = await collect(p.run('s', 'slice it'))
    expect(Object.keys(seen?.run ?? {}).sort()).toEqual(['fingerprint', 'update'])
    expect(seen?.run).not.toHaveProperty('recordSend')
    expect(seen?.run).not.toHaveProperty('recordJob')
    expect(p.printRun!('s')!.printerId).toBe('p7')
    const result = events.find((e) => e.type === 'tool_result')
    expect(JSON.stringify(result)).toContain('fp1:p2')
  })

  it('a slice the engine refused reads as failed, with the reason, and leaves no slice to send', async () => {
    const shared = createShared()
    shared.slices.set(1, { plate: 1, result: { id: 'old' } as unknown as SliceResult })
    const command: CommandSpec = {
      id: 'slice',
      title: 'Slice the plate',
      section: 'slice',
      tool: { permission: 'slice' },
      run: (_input?: unknown, cx?: CommandToolContext) => {
        cx?.refused?.(1)
        return { status: 'error', message: 'toolpaths lie outside the printable area from layer 1 (X-7.5 Y-7.5, Peg); move Peg onto the bed or arrange the plate' }
      },
    }
    const p = pilot([{ calls: [{ name: 'app.slice', args: {} }] }, { text: 'Done.' }], fakeHost('fp1'), fakeSlicer([{}]), [1], commandTools([command], shared))
    const events = await collect(p.run('s', 'slice it'))
    const result = events.find((e) => e.type === 'tool_result')
    expect(result).toMatchObject({ ok: false, summary: 'Toolpaths lie outside the printable area from layer 1 (X-7.5 Y-7.5, Peg); move Peg onto the bed or arrange the plate.' })
    expect(p.printRun!('s')?.slice ?? null).toBeNull()
    expect(shared.slices.has(1)).toBe(false)
  })

  it('a command reply without an error still reads as done', async () => {
    const command: CommandSpec = { id: 'slice', title: 'Slice the plate', section: 'slice', tool: { permission: 'slice' }, run: () => ({ status: 'stale', message: 'Slice the plate again.' }) }
    const p = pilot([{ calls: [{ name: 'app.slice', args: {} }] }, { text: 'Done.' }], fakeHost('fp1'), fakeSlicer([{}]), [1], commandTools([command]))
    const result = (await collect(p.run('s', 'slice it'))).find((e) => e.type === 'tool_result')
    expect(result).toMatchObject({ ok: true, summary: 'Slice the plate done' })
  })
})
