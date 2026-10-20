// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// run.target: the printer and spool a chat prints with, from the person's words ("my A1", "black PETG"), else their
// notes, else the only printer online or the only one holding the spools asked for. The picker card comes up only when
// none of that settles it, and None of these changes nothing. Setting the target after a slice makes that slice stale,
// and an edition with printers off has no run.target at all.
import { DEFAULT_POLICY, type FilamentSlot, type PilotChoice, type PilotEvent, type PrinterHost, type PrinterInfo, type PrinterStatus, type RunSlice } from '@slicerx/contracts'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import type { MemoryFact, MemoryStore } from '../src/memory/facts'
import { createApprovalBroker } from '../src/permit/broker'
import { createScriptedClient } from '../src/provider/scripted'
import { createPilot } from '../src/runtime'
import { applyToolGroups, builtinTools, colorWord, colorWordHex, createRunBook, runHandle, runTools, toolGroupOf, type RunLanded, type RunTarget, type RunTargetResult, type ToolContext } from '../src/index'

const A1: PrinterInfo = { id: 'bay-1', name: 'Desk', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1, filamentSystem: 'ams' }
const MINI: PrinterInfo = { id: 'bay-2', name: 'Shelf', vendor: 'Bambu Lab', model: 'A1 mini', plugin: 'bambu-lan', nozzleCount: 1, filamentSystem: 'ams' }
const A1B: PrinterInfo = { id: 'bay-3', name: 'Garage', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1, filamentSystem: 'ams' }

const WHITE_PLA: FilamentSlot = { id: 'A1', material: 'PLA', color: '#FFFFFF' }
const BLACK_PETG: FilamentSlot = { id: 'A2', material: 'PETG', color: '#161616' }

const status = (printerId: string, slots: FilamentSlot[], state: PrinterStatus['state'] = 'idle'): PrinterStatus => ({ printerId, state, nozzles: [], slots, cameraAvailable: false, updatedAt: '2026-10-19T00:00:00.000Z' })

const SLICE: RunSlice = { sliceId: 'sl1', plate: 1, at: '2026-10-19T00:00:00.000Z', timeS: 600, grams: 4, cost: 0.1, warnings: [], fingerprint: 'fp1', stale: false }

function memory(facts: Partial<MemoryFact>[]): MemoryStore {
  const all = facts.map((f, i) => ({ id: `m${i}`, kind: 'printer' as const, text: '', updatedAt: i, ...f }))
  return { list: async () => all, put: async () => undefined, remove: async () => undefined, clear: async () => undefined }
}

/** Runs run.target on a fleet. `answer` picks on the card; every question it was asked is kept. */
async function target(input: Record<string, unknown>, o: { printers?: PrinterInfo[]; statuses?: PrinterStatus[]; memory?: MemoryStore; answer?: (choices: PilotChoice[]) => string; landed?: RunLanded } = {}) {
  const printers = o.printers ?? [A1, MINI]
  const statuses = o.statuses ?? [status('bay-1', [WHITE_PLA, BLACK_PETG]), status('bay-2', [{ id: 'A1', material: 'PLA', color: '#000000' }])]
  const host = {
    list: async () => printers,
    status: async (id: string) => {
      const s = statuses.find((x) => x.printerId === id)
      if (!s) throw new Error('offline')
      return s
    },
  } as unknown as PrinterHost
  const setTarget = vi.fn(async (_t: RunTarget): Promise<RunLanded | void> => o.landed)
  const book = createRunBook({ fingerprint: () => 'fp1', setTarget }, () => 0)
  book.update('s', { slice: SLICE })
  const asks: { title: string; question: string; choices: PilotChoice[] }[] = []
  const ctx = {
    host: { printers: host },
    sessionId: 's',
    run: runHandle(book, 's'),
    ask: async (q: { title: string; question: string; choices: PilotChoice[] }) => {
      asks.push(q)
      return o.answer ? o.answer(q.choices) : 'pick:none'
    },
  } as unknown as ToolContext
  const tool = runTools({ memory: o.memory })[0]!
  const out = await tool.run(input as never, ctx)
  return { out, result: out.output as RunTargetResult | undefined, asks, setTarget, run: book.get('s') }
}

describe('run.target', () => {
  it('"my A1" picks the A1, not the A1 mini', async () => {
    const { result, asks } = await target({ printer: 'my A1' })
    expect(asks).toHaveLength(0)
    expect(result).toMatchObject({ printerId: 'bay-1', printerName: 'Desk', from: 'words' })
    // the A1 mini is still found by its own words
    expect((await target({ printer: 'the A1 mini' })).result?.printerId).toBe('bay-2')
  })

  it('"black PETG" matches the black PETG slot', async () => {
    const { result, asks, setTarget, run } = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] })
    expect(asks).toHaveLength(0)
    expect(result?.slots).toEqual([{ filament: 1, slot: 'A2', material: 'PETG', color: 'black' }])
    expect(setTarget).toHaveBeenCalledWith(expect.objectContaining({ printerId: 'bay-1', slots: { 1: 'A2' } }))
    expect(run.printerId).toBe('bay-1')
    expect(run.slots).toEqual({ 1: 'A2' })
  })

  it('memory settles the printer when none is named', async () => {
    const { result, asks } = await target({}, { memory: memory([{ kind: 'printer', text: 'Prints mostly on the A1 mini in the shelf' }]) })
    expect(asks).toHaveLength(0)
    expect(result).toMatchObject({ printerId: 'bay-2', from: 'memory' })
  })

  it('the only online printer needs no question', async () => {
    const { result, asks } = await target({ filaments: [{ material: 'PLA' }] }, { statuses: [status('bay-1', [WHITE_PLA, BLACK_PETG]), status('bay-2', [], 'offline')] })
    expect(asks).toHaveLength(0)
    expect(result).toMatchObject({ printerId: 'bay-1', from: 'only', slots: [{ filament: 1, slot: 'A1', material: 'PLA', color: 'white' }] })
  })

  it('one printer holding the spool asked for needs no question', async () => {
    const { result, asks } = await target({ filaments: [{ material: 'PETG', color: 'black' }] })
    expect(asks).toHaveLength(0)
    expect(result).toMatchObject({ printerId: 'bay-1', from: 'words', slots: [{ filament: 1, slot: 'A2' }] })
  })

  it('a printer name that matches nothing still picks the only printer holding the spool, and says the name matched nothing', async () => {
    const { result, asks, out } = await target({ printer: 'the big one', filaments: [{ material: 'PETG', color: 'black' }] })
    expect(asks).toHaveLength(0)
    expect(result).toMatchObject({ printerId: 'bay-1', from: 'only', slots: [{ filament: 1, slot: 'A2' }] })
    expect(out.summary).toContain('No printer matches "the big one", so I picked Desk')
  })

  it('"my printer" is no name: the only printer holding the spool needs no question and no word about the name', async () => {
    for (const printer of ['my printer', 'the printer', 'Printer', 'my 3D printer', 'my 3D-printer', 'the printers', 'the usual printer', 'any printer']) {
      const { result, asks, out } = await target({ printer, filaments: [{ material: 'PETG', color: 'black' }] })
      expect(asks).toHaveLength(0)
      expect(result).toMatchObject({ printerId: 'bay-1', from: 'words' })
      expect(out.summary).not.toContain('matches')
    }
  })

  it('a named printer that is offline is never swapped for the only fit: it says so and asks', async () => {
    // the A1 (Desk) is off; the A1 mini online holds the black PLA asked for
    const statuses = [status('bay-2', [{ id: 'A1', material: 'PLA', color: '#000000' }])]
    const { asks, result, out } = await target({ printer: 'my A1', filaments: [{ material: 'PLA', color: 'black' }] }, { statuses })
    expect(asks).toHaveLength(1)
    expect(asks[0]!.question).toContain('Desk is offline.')
    expect(asks[0]!.question).not.toContain('No printer matches')
    expect(result).toBeUndefined()
    expect(out.ok).toBe(false)
  })

  it('a named printer that is offline stops with that fact when there is no one to ask', async () => {
    const statuses = [status('bay-2', [{ id: 'A1', material: 'PLA', color: '#000000' }])]
    const printers = [A1, MINI]
    const host = { list: async () => printers, status: async (id: string) => { const s = statuses.find((x) => x.printerId === id); if (!s) throw new Error('offline'); return s } } as unknown as PrinterHost
    const book = createRunBook({ fingerprint: () => 'fp1', setTarget: async () => undefined }, () => 0)
    const ctx = { host: { printers: host }, sessionId: 's', run: runHandle(book, 's') } as unknown as ToolContext
    const out = await runTools()[0]!.run({ printer: 'Desk', filaments: [{ material: 'PLA' }] } as never, ctx)
    expect(out.ok).toBe(false)
    expect(out.summary).toContain('Desk is offline.')
    expect(book.get('s').printerId).toBeFalsy()
  })

  it('a printer really named "Printer" wins over the filler reading', async () => {
    const named: PrinterInfo = { ...MINI, id: 'bay-9', name: 'Printer' }
    const statuses = [status('bay-1', [WHITE_PLA, BLACK_PETG]), status('bay-9', [{ id: 'A1', material: 'PETG', color: '#161616' }])]
    const { result, asks } = await target({ printer: 'Printer', filaments: [{ material: 'PETG', color: 'black' }] }, { printers: [A1, named], statuses })
    expect(asks).toHaveLength(0)
    expect(result).toMatchObject({ printerId: 'bay-9', from: 'words' })
  })

  it('a printer name that matches nothing still asks when the spool does not settle it', async () => {
    const { asks } = await target({ printer: 'the big one', filaments: [{ material: 'PLA' }] })
    expect(asks).toHaveLength(1)
    expect(asks[0]!.question).toContain('No printer matches "the big one".')
  })

  it('a spool loaded on two printers still asks', async () => {
    const { asks } = await target({ filaments: [{ material: 'PLA' }] })
    expect(asks).toHaveLength(1)
    expect(asks[0]!.question).toContain('2 printers are online.')
  })

  it('two matching printers ask', async () => {
    const statuses = [status('bay-1', [WHITE_PLA, BLACK_PETG]), status('bay-3', [{ id: 'A1', material: 'PLA', color: '#2050C0' }])]
    const { result, asks } = await target({ printer: 'A1' }, { printers: [A1, A1B], statuses, answer: () => 'pick:bay-3:A1' })
    expect(asks).toHaveLength(1)
    expect(asks[0]!.title).toBe('Which printer and spool?')
    expect(asks[0]!.choices).toEqual([
      { id: 'pick:bay-1:A1', label: 'Desk, slot A1: PLA, White' },
      { id: 'pick:bay-1:A2', label: 'Desk, slot A2: PETG, Black' },
      { id: 'pick:bay-3:A1', label: 'Garage, slot A1: PLA, Blue' },
      { id: 'pick:none', label: 'None of these' },
    ])
    expect(result).toMatchObject({ printerId: 'bay-3', from: 'picked', slots: [{ filament: 1, slot: 'A1' }] })
  })

  it('a filament that is not loaded asks', async () => {
    const statuses = [status('bay-1', [WHITE_PLA]), status('bay-2', [], 'offline')]
    const { asks, result } = await target({ printer: 'Desk', filaments: [{ material: 'PETG' }] }, { statuses, answer: () => 'pick:bay-1:A1' })
    expect(asks).toHaveLength(1)
    expect(asks[0]!.question).toContain('Desk has no PETG loaded.')
    expect(asks[0]!.choices.map((c) => c.id)).toEqual(['pick:bay-1:A1', 'pick:none'])
    // the person can still print from the spool they picked
    expect(result).toMatchObject({ printerId: 'bay-1', from: 'picked', slots: [{ filament: 1, slot: 'A1' }] })
  })

  it('a printer that has reported no slots asks', async () => {
    const statuses = [status('bay-1', []), status('bay-2', [{ id: 'A1', material: 'PLA', color: '#000000' }])]
    const { asks } = await target({ printer: 'Desk', filaments: [{ material: 'PLA' }] }, { statuses })
    expect(asks[0]?.question).toContain('Desk has not reported its spools yet.')
  })

  it('None of these changes nothing', async () => {
    const { out, asks, setTarget, run } = await target({}, { answer: () => 'pick:none' })
    expect(asks).toHaveLength(1)
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('No printer picked. Nothing changed.')
    expect(setTarget).not.toHaveBeenCalled()
    expect(run.printerId).toBeNull()
    expect(run.slice?.stale).toBe(false)
  })

  it('the target marks an earlier slice stale', async () => {
    const { run } = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] })
    expect(run.slice?.sliceId).toBe('sl1')
    expect(run.slice?.stale).toBe(true)
  })

  it('a color word it does not know is said in the reply', async () => {
    const { out, result, asks } = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'mauve' }] })
    expect(asks).toHaveLength(0)
    // matched by material only, and the reply says so instead of passing over the word
    expect(result?.slots).toEqual([{ filament: 1, slot: 'A2', material: 'PETG', color: 'black' }])
    expect(out.summary).toBe('Printing on Desk from slot A2 (PETG, black). "mauve" is not a color I know, so its spool was matched by material only.')
    // a color it knows adds nothing
    expect((await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] })).out.summary).not.toContain('not a color')
    // two it does not know, and the question on the card says it too
    const two = await target({ printer: 'Desk', filaments: [{ material: 'ABS', color: 'mauve' }, { material: 'PLA', color: 'teal' }] })
    expect(two.asks[0]!.question).toContain('"mauve" and "teal" are not colors I know, so their spools were matched by material only.')
  })

  it('hands the host the model of the printer, so it can load that bed before landing the parts', async () => {
    const { setTarget } = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] })
    expect(setTarget).toHaveBeenCalledWith(expect.objectContaining({ printerId: 'bay-1', model: { vendor: 'Bambu Lab', model: 'A1' } }))
  })

  it('says which parts the new bed moved', async () => {
    const { out, result } = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] }, { landed: { moved: [{ name: 'Clip', plate: 'Plate 1' }, { name: 'Clip', plate: 'Plate 1' }], offBed: [] } })
    expect(out.ok).not.toBe(false)
    expect(out.summary).toBe("Printing on Desk from slot A2 (PETG, black). Moved Clip to fit Desk's bed.")
    expect(result?.moved).toEqual([{ name: 'Clip', plate: 'Plate 1' }, { name: 'Clip', plate: 'Plate 1' }])
    expect(result?.offBed).toBeUndefined()
  })

  it('says in plain words when a part has no room on the new bed', async () => {
    const one = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] }, { landed: { moved: [], offBed: [{ name: 'Clip', plate: 'Plate 1' }] } })
    expect(one.out.summary).toBe("Printing on Desk from slot A2 (PETG, black). Clip does not fit on Desk's bed. Scale it down or pick another printer.")
    expect(one.result?.offBed).toEqual([{ name: 'Clip', plate: 'Plate 1' }])
    const two = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] }, { landed: { moved: [{ name: 'Knob', plate: 'Plate 1' }], offBed: [{ name: 'Base', plate: 'Plate 1' }, { name: 'Lid', plate: 'Plate 1' }] } })
    expect(two.out.summary).toBe("Printing on Desk from slot A2 (PETG, black). Moved Knob to fit Desk's bed. Base and Lid do not fit on Desk's bed. Scale them down or pick another printer.")
    // no setting keys or ids in what the person reads
    expect(two.out.summary).not.toMatch(/bed_exclude_area|printable_area|brim_width|skirt|bay-1/)
  })

  it('names the plate of each part when the project has more than one', async () => {
    const f = [{ material: 'PETG', color: 'black' }]
    const a = await target({ printer: 'Desk', filaments: f }, { landed: { moved: [{ name: 'Clip', plate: 'Plate 2' }], offBed: [{ name: 'Base', plate: 'Plate 1' }], manyPlates: true } })
    expect(a.out.summary).toBe("Printing on Desk from slot A2 (PETG, black). Moved Clip on Plate 2 to fit Desk's bed. Base on Plate 1 does not fit on Desk's bed. Scale it down or pick another printer.")
    const b = await target({ printer: 'Desk', filaments: f }, { landed: { moved: [{ name: 'Clip', plate: 'Plate 1' }], offBed: [] } })
    expect(b.out.summary).toBe("Printing on Desk from slot A2 (PETG, black). Moved Clip to fit Desk's bed.")
  })

  it('says the bed, not the printer, when its profile did not build', async () => {
    const { out } = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] }, { landed: { moved: [{ name: 'Clip', plate: 'Plate 1' }], offBed: [{ name: 'Base', plate: 'Plate 1' }], genericBed: true } })
    expect(out.summary).toBe('Printing on Desk from slot A2 (PETG, black). Moved Clip to fit the bed. Base does not fit on the bed. Scale it down or pick another printer.')
  })

  it('says the bed was not ready when the host did not wait for it', async () => {
    const { out } = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] }, { landed: { moved: [], offBed: [], bedNotReady: true } })
    expect(out.summary).toBe("Printing on Desk from slot A2 (PETG, black). Desk's bed was not ready, so parts were not checked against it.")
  })

  it('a bed that moved nothing adds nothing to the reply', async () => {
    const { out, result } = await target({ printer: 'Desk', filaments: [{ material: 'PETG', color: 'black' }] }, { landed: { moved: [], offBed: [] } })
    expect(out.summary).toBe('Printing on Desk from slot A2 (PETG, black).')
    expect(result).not.toHaveProperty('moved')
    expect(result).not.toHaveProperty('offBed')
  })

  it('printers off leaves run.target out', () => {
    const tools = builtinTools({ planner: undefined, commands: [] })
    expect(tools.map((t) => t.name)).toContain('run.target')
    expect(toolGroupOf({ name: 'run.target' })).toBe('printers')
    expect(applyToolGroups(tools, { printers: false }).map((t) => t.name)).not.toContain('run.target')
    expect(applyToolGroups(tools, { design: false }).map((t) => t.name)).toContain('run.target')
  })
})

describe('color words', () => {
  it('names each listed color and reads spool colors back', () => {
    for (const w of ['black', 'white', 'gray', 'silver', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown', 'beige', 'transparent']) {
      const hex = colorWordHex(w)
      expect(hex, w).toMatch(/^#[0-9A-F]{6}/)
      expect(colorWord(hex!), w).toBe(w)
    }
    expect(colorWordHex('Matte Black')).toBe('#000000')
    expect(colorWordHex('grey')).toBe(colorWordHex('gray'))
    expect(colorWordHex('sparkly')).toBeNull()
    expect(colorWord('#161616')).toBe('black')
    expect(colorWord('#0A2989')).toBe('blue')
  })
})

describe('run.target in the running pilot', () => {
  /** A pilot with the edition's memory switch, two online printers and a printer note, whose model calls run.target. */
  async function chat(local: boolean) {
    const statuses = [status('bay-1', [WHITE_PLA, BLACK_PETG]), status('bay-2', [{ id: 'A1', material: 'PLA', color: '#000000' }])]
    const printers = {
      list: async () => [A1, MINI],
      plugins: async () => [],
      fleets: async () => [],
      status: async (id: string) => statuses.find((x) => x.printerId === id)!,
      subscribe: () => () => undefined,
    } as unknown as PrinterHost
    const setTarget = vi.fn(async (_t: RunTarget) => undefined)
    const pilot = createPilot({
      host: { printers, llm: { available: async () => false, stream: () => { throw new Error('scripted') } }, approvals: createApprovalBroker() },
      config: DEFAULT_CONFIG,
      policy: DEFAULT_POLICY,
      client: createScriptedClient([{ calls: [{ name: 'run.target', args: {} }] }, { text: 'Done.' }], { chunk: false }),
      memory: { local, store: memory([{ kind: 'printer', text: 'Prints mostly on the A1 mini in the shelf' }]) },
      printRun: { fingerprint: () => 'fp1', setTarget },
    })
    const asks: string[] = []
    const calls = new Set<string>()
    const results: Extract<PilotEvent, { type: 'tool_result' }>[] = []
    for await (const ev of pilot.run('s', 'Get it ready to print')) {
      if (ev.type === 'approval_request') await pilot.resolveApproval(ev.request.id, { kind: 'approve' })
      if (ev.type === 'ask') {
        asks.push(ev.question)
        await pilot.answer!(ev.askId, 'pick:none')
      }
      if (ev.type === 'tool_call' && ev.tool === 'run.target') calls.add(ev.callId)
      if (ev.type === 'tool_result' && calls.has(ev.callId)) results.push(ev)
    }
    return { asks, results, setTarget }
  }

  it('a printer note settles the printer with no question', async () => {
    const { asks, results, setTarget } = await chat(true)
    expect(asks).toEqual([])
    expect(results.map((r) => r.ok)).toEqual([true])
    expect(setTarget).toHaveBeenCalledWith(expect.objectContaining({ printerId: 'bay-2' }))
  })

  it('with memory off the note is not read, so it asks', async () => {
    const { asks, setTarget } = await chat(false)
    expect(asks).toEqual(['2 printers are online. Pick the spool to print with.'])
    expect(setTarget).not.toHaveBeenCalled()
  })
})
