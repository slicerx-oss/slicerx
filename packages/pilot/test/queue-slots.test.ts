// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// printer.queue on a printer that follows a slot map: the plate goes as a .gcode.3mf with each filament matched to a
// loaded slot the way the Print sheet matches it, a client's own map wins, and a send that cannot work is refused
// before any card, in words a client can pass on.
import type { ApprovalRequest, FilamentSlot, PilotEvent, PilotMachine, RemoteFile, StartOptions } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, type EvalObject } from '../evals/harness'
import { createScriptedClient } from '../src/provider/scripted'
import { supportedOptions } from '@slicerx/printer-catalog/send-options'
import { autoSlotMap, plateFilaments, queuePrintOptions, refuseDuplicateSlots } from '../src/tools/printers'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const CLIP: EvalObject = { id: 'clip', name: 'Clip', bboxMm: [30, 12, 8] }
/** The print options a P1S starts with on the Print sheet: leveling and timelapse on, vibration compensation off. */
const P1S = { bedLeveling: true, vibrationCompensation: false, timelapse: true }

type ToolResult = Extract<PilotEvent, { type: 'tool_result' }>

/** Slices, then queues with `args`, approving every card (after `onCard`, when given). Records each start the printer got. */
async function queue(args: Record<string, unknown>, opts: { slots?: FilamentSlot[]; onCard?: (bay2: { slots: FilamentSlot[] }) => void } = {}) {
  let bay2: { slots: FilamentSlot[] } | undefined
  const env = createEvalEnv({
    client: createScriptedClient([{ calls: [{ name: 'slice', args: {} }] }, { calls: [{ name: 'printer.queue', args }] }, { text: 'done' }]),
    machine: MACHINE,
    objects: [CLIP],
    // Bay 2 is a P1S with PLA in A1 and A2 and ASA in A3, unless the test loads others.
    fleet: (f) => {
      bay2 = f.printers.find((p) => p.id === 'bay-2') as unknown as { slots: FilamentSlot[] }
      if (opts.slots) bay2.slots = opts.slots
      return f
    },
  })
  const starts: { file: RemoteFile; opts: StartOptions }[] = []
  const start = env.sim.start.bind(env.sim)
  env.sim.start = async (file, o, token) => {
    starts.push({ file, opts: o })
    return start(file, o, token)
  }
  const events: PilotEvent[] = []
  const cards: ApprovalRequest[] = []
  for await (const ev of env.pilot.run('t', 'test', { context: { machine: MACHINE } })) {
    events.push(ev)
    if (ev.type === 'approval_request') {
      cards.push(ev.request)
      if (bay2) opts.onCard?.(bay2)
      await env.pilot.resolveApproval(ev.request.id, { kind: 'approve', bedClear: true })
    }
  }
  // The queue's result is the last one: slice runs first.
  const result = events.filter((e): e is ToolResult => e.type === 'tool_result').at(-1)
  return { env, starts, cards, result }
}

describe('printer.queue on a Bambu Lab printer', () => {
  it('matches the plate filament to a loaded slot, shows it on the card, and sends a .gcode.3mf with that map', async () => {
    // Bay 2 is a P1S with PLA in A1 and A2 and ASA in A3.
    const { starts, cards, result } = await queue({ printerId: 'bay-2', plate: 1 })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.lines).toContain('Filament slots: filament 1 from slot A1 (matched to what is loaded)')
    expect(cards[0]?.lines).toContain('Uploads the .gcode.3mf and starts the print')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.file.name).toMatch(/\.gcode\.3mf$/)
    expect(starts[0]?.opts).toEqual({ ...P1S, slotMap: { 0: 'A1' } })
    // Read back: the map that went to the printer, 0 based like the input.
    expect(result?.ok).toBe(true)
    expect(result?.output).toMatchObject({ printerId: 'bay-2', slotMap: { '0': 'A1' }, slotMapSource: 'auto' })
    expect(String((result?.output as { file: string }).file)).toMatch(/\.gcode\.3mf$/)
  })

  it('picks the slot of the closest color among the loaded slots of the material', async () => {
    const slots: FilamentSlot[] = [
      { id: 'A1', material: 'PETG', color: '#FFFFFF' },
      { id: 'A2', material: 'PLA', color: '#000000' },
      { id: 'A3', material: 'PLA Matte', color: '#F0F0F0' },
    ]
    // The eval project's filament is PLA with no color, so color breaks no tie: the first PLA slot, A2.
    expect((await queue({ printerId: 'bay-2', plate: 1 }, { slots })).starts[0]?.opts).toEqual({ ...P1S, slotMap: { 0: 'A2' } })
    // With a white filament, the near-white PLA slot wins.
    expect(autoSlotMap([{ index: 1, type: 'PLA', color: '#FFFFFF' }], slots, 'P1S')).toEqual({ 1: 'A3' })
  })

  it('starts from the slots the card showed, even when the printer reports others before the approval', async () => {
    const { starts, result } = await queue(
      { printerId: 'bay-2', plate: 1 },
      {
        // A1 changes to PETG while the card is open: a fresh match would now pick A2.
        onCard: (bay2) => {
          bay2.slots.splice(0, 1, { id: 'A1', material: 'PETG', color: '#ffffff' })
        },
      },
    )
    expect(starts[0]?.opts).toEqual({ ...P1S, slotMap: { 0: 'A1' } })
    expect(result?.output).toMatchObject({ slotMap: { '0': 'A1' } })
  })

  it("uses the client's slot map over the match", async () => {
    const { starts, cards, result } = await queue({ printerId: 'bay-2', plate: 1, slotMap: { '0': 'A2' } })
    expect(cards[0]?.lines).toContain('Filament slots: filament 1 from slot A2')
    expect(starts[0]?.opts).toEqual({ ...P1S, slotMap: { 0: 'A2' } })
    expect(starts[0]?.file.name).toMatch(/\.gcode\.3mf$/)
    expect(result?.output).toMatchObject({ slotMap: { '0': 'A2' }, slotMapSource: 'client' })
  })

  it('refuses, before any card, a filament with no loaded slot of its material', async () => {
    const { env, cards, result } = await queue({ printerId: 'bay-2', plate: 1 }, { slots: [{ id: 'A1', material: 'PETG', color: '#ffffff' }, { id: 'A2' }] })
    expect(cards).toEqual([])
    expect(result?.ok).toBe(false)
    expect(result?.summary).toBe('Bay 2 has no loaded slot of the right material for filament 1 (pla): load it in the AMS or on the external spool and send again, or pass slotMap to pick the slots.')
    expect(env.audit.sideEffects).toEqual([])
  })

  it('refuses, before any card, while the printer has reported no slots yet', async () => {
    const { env, cards, result } = await queue({ printerId: 'bay-2', plate: 1 }, { slots: [] })
    expect(cards).toEqual([])
    expect(result?.summary).toMatch(/has not reported its filament slots yet, so SlicerX cannot match the plate's filaments to them: wait a few seconds and send again, or pass slotMap\.$/)
    expect(env.audit.sideEffects).toEqual([])
  })

  it('refuses, before any card, two filaments in one slot', async () => {
    const { env, cards, result } = await queue({ printerId: 'bay-2', plate: 1, slotMap: { '0': 'A1', '1': 'A1' } })
    expect(cards).toEqual([])
    expect(result?.summary).toMatch(/^Filaments 1 and 2 would both feed from slot A1 on .+, which cannot work: give each filament its own slot in slotMap\.$/)
    expect(env.audit.sideEffects).toEqual([])
  })
})

describe('printer.queue print options', () => {
  it("sends the client's options over the printer's defaults, lists each one on the card and reads them back", async () => {
    const { starts, cards, result } = await queue({ printerId: 'bay-2', plate: 1, options: { timelapse: false, bedLeveling: false } })
    // The card lists every option the P1S offers, in the Print sheet's order, as it will be sent.
    expect(cards[0]?.lines).toEqual(expect.arrayContaining(['Bed leveling: off', 'Vibration compensation: off', 'Timelapse: off']))
    expect(cards[0]?.lines.join(' ')).not.toMatch(/Flow dynamics calibration|First layer inspection/)
    expect(starts[0]?.opts).toEqual({ bedLeveling: false, vibrationCompensation: false, timelapse: false, slotMap: { 0: 'A1' } })
    expect(result?.output).toMatchObject({ options: { bedLeveling: false, vibrationCompensation: false, timelapse: false } })
  })

  it('refuses, before any card, an option the printer does not offer, naming the ones it does', async () => {
    // A P1S has no flow dynamics calibration and no lidar for first layer inspection.
    const { env, cards, result } = await queue({ printerId: 'bay-2', plate: 1, options: { flowCalibration: true, firstLayerInspection: false } })
    expect(cards).toEqual([])
    expect(result?.ok).toBe(false)
    expect(result?.summary).toBe('Bay 2 has no flow dynamics calibration and first layer inspection, so nothing was sent: leave them out of options. It offers bed leveling, vibration compensation and timelapse.')
    expect(env.audit.sideEffects).toEqual([])
  })

  it('starts with the options the card showed, even when the printer loses its camera before the approval', async () => {
    const { starts } = await queue(
      { printerId: 'bay-2', plate: 1 },
      {
        onCard: (bay2) => {
          ;(bay2 as unknown as { cameraAvailable: boolean }).cameraAvailable = false
        },
      },
    )
    expect(starts[0]?.opts).toEqual({ ...P1S, slotMap: { 0: 'A1' } })
  })

  it('refuses any option on a printer that takes none', async () => {
    // Bay 3 is a Prusa MK4S on PrusaLink: it takes no print options from here.
    const prusa = await queue({ printerId: 'bay-3', plate: 1, options: { timelapse: true } })
    expect(prusa.cards).toEqual([])
    expect(prusa.result?.summary).toBe('Bay 3 has no timelapse, so nothing was sent: leave it out of options. It takes no print options from here.')
  })
})

describe('printer.queue on a printer that takes filament as the G-code says', () => {
  it('sends plain G-code with no slot map, as before', async () => {
    // Bay 4 is a Voron on Moonraker, finished and ready for the next job.
    const { starts, cards, result } = await queue({ printerId: 'bay-4', plate: 1 })
    expect(cards[0]?.lines.some((l) => l.startsWith('Filament slots'))).toBe(false)
    expect(cards[0]?.lines).toContain('Uploads the G-code and starts the print')
    expect(starts[0]?.file.name).toMatch(/\.gcode$/)
    expect(starts[0]?.opts).toEqual({})
    expect(result?.ok, result?.summary).toBe(true)
    expect(result?.output).not.toHaveProperty('slotMap')
  })

  it('still refuses a slot map there', async () => {
    const { cards, result } = await queue({ printerId: 'bay-4', plate: 1, slotMap: { '0': '1' } })
    expect(cards).toEqual([])
    expect(result?.summary).toMatch(/cannot follow a filament slot map/)
  })
})

describe('slot matching helpers', () => {
  it('lists the filaments a plate prints with, from the grams per filament and the slice settings', () => {
    const config = { filament_type: ['PLA', 'PETG', 'TPU'], filament_colour: ['#ff0000', '#00ff00', '#0000ff'] }
    expect(plateFilaments({ filamentG: [12, 0, 3] }, config)).toEqual([
      { index: 1, type: 'PLA', color: '#ff0000' },
      { index: 3, type: 'TPU', color: '#0000ff' },
    ])
    // One total is filament 1; with no filament type the machine's material stands in.
    expect(plateFilaments({ filamentG: [20] }, {}, 'pla')).toEqual([{ index: 1, type: 'pla', color: '' }])
  })

  it('names every filament with no slot, and every filament sharing one', () => {
    expect(() => autoSlotMap([{ index: 1, type: 'PLA', color: '' }, { index: 2, type: 'TPU', color: '' }, { index: 3, type: 'PA', color: '' }], [{ id: 'A1', material: 'PLA' }], 'P1S')).toThrow(
      'P1S has no loaded slot of the right material for filament 2 (TPU) and filament 3 (PA): load them in the AMS or on the external spool and send again, or pass slotMap to pick the slots.',
    )
    expect(() => refuseDuplicateSlots({ 0: 'A1', 1: 'A1', 2: 'A1' }, 'P1S')).toThrow('Filaments 1, 2 and 3 would all feed from slot A1 on P1S, which cannot work: give each filament its own slot in slotMap.')
    expect(() => refuseDuplicateSlots({ 0: 'A1', 1: 'A2' }, 'P1S')).not.toThrow()
  })

  it('codes each refusal, so a client can tell them apart', () => {
    const code = (f: () => unknown): unknown => {
      try {
        f()
      } catch (e) {
        return (e as { code?: unknown }).code
      }
      return null
    }
    expect(code(() => autoSlotMap([{ index: 1, type: 'PLA', color: '' }], [], 'P1S'))).toBe('slots_not_reported')
    expect(code(() => autoSlotMap([{ index: 1, type: 'PLA', color: '' }], [{ id: 'A1', material: 'ABS' }], 'P1S'))).toBe('no_matching_slot')
    expect(code(() => refuseDuplicateSlots({ 0: 'A1', 1: 'A1' }, 'P1S'))).toBe('duplicate_slot')
  })
})

describe('queuePrintOptions', () => {
  const a1 = { vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan' }

  it("starts from an A1's defaults on the Print sheet and takes the client's choices over them", () => {
    const specs = supportedOptions(a1, { cameraAvailable: true })
    expect(queuePrintOptions(specs, undefined, 'A1')).toEqual({ bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: false })
    expect(queuePrintOptions(specs, {}, 'A1')).toEqual({ bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: false })
    expect(queuePrintOptions(specs, { timelapse: true, flowCalibration: false }, 'A1')).toEqual({ bedLeveling: true, flowCalibration: false, vibrationCompensation: false, timelapse: true })
  })

  it('refuses first layer inspection on an A1, and timelapse once it reports no camera, with a code', () => {
    const specs = supportedOptions(a1, { cameraAvailable: true })
    expect(() => queuePrintOptions(specs, { firstLayerInspection: true }, 'A1')).toThrow('A1 has no first layer inspection, so nothing was sent: leave it out of options. It offers bed leveling, flow dynamics calibration, vibration compensation and timelapse.')
    const blind = supportedOptions(a1, { cameraAvailable: false })
    try {
      queuePrintOptions(blind, { timelapse: false }, 'A1')
      expect.unreachable()
    } catch (e) {
      expect((e as { code?: string }).code).toBe('unsupported_option')
      expect((e as Error).message).toMatch(/^A1 has no timelapse/)
    }
  })

  it('follows the model the printer reports over the one it was added as', () => {
    // Added as an A1, reporting an X1 Carbon: inspection is offered and on by default.
    const specs = supportedOptions(a1, { cameraAvailable: true, model: 'X1 Carbon' })
    expect(queuePrintOptions(specs, undefined, 'Bay')).toMatchObject({ firstLayerInspection: true, timelapse: true })
  })
})
