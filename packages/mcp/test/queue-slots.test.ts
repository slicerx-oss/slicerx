// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_printer_queue the way a client calls it, for a Bambu Lab printer: the hub gets a .gcode.3mf with the slot
// map matched to what is loaded (or the client's own) and the print options the Print sheet would send, the answer
// reads both back, and a plate the printer cannot feed or an option it does not have is refused before any card.
import { join } from 'node:path'
import type { ApprovalRequest } from '@slicerx/contracts'
import { hashParams } from '@slicerx/contracts'
import type { AgentWork } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { stubOutput } from '../src/printers'
import { readZip } from '../src/zip'
import { connect, data, text } from './helpers'

/** Stands in for the hub: keeps each card and its work. */
function fakeHub(h: Awaited<ReturnType<typeof connect>>) {
  const sent: { request: ApprovalRequest; work: AgentWork }[] = []
  h.ctx.gate.handOff = {
    register: async (request, work) => {
      sent.push({ request, work })
    },
    onDone: () => () => undefined,
  }
  return sent
}

/** A sliced one-cube plate for a P1S, with filament 1 as given. */
async function sliced(filament: { type?: string; color?: string } = {}) {
  const h = await connect()
  const sent = fakeHub(h)
  await h.call('slicerx_project_open', { name: 'Brackets', printer: 'bambu_p1s', filament: 'pla' })
  if (filament.type || filament.color) {
    const set = await h.call('slicerx_project_set_filament', { slot: 1, ...filament })
    expect(set.isError, text(set)).toBeFalsy()
  }
  await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 1 })
  const s = await h.call('slicerx_slice', {})
  expect(s.isError, text(s)).toBeFalsy()
  return { h, sent }
}

interface Answer {
  status: string
  request_id?: string
  lines: string[]
  file?: string
  slot_map?: Record<string, string>
  options?: Record<string, boolean>
}

/** The print options a P1S starts with on the Print sheet. */
const P1S = { bedLeveling: true, vibrationCompensation: false, timelapse: true }

/** Bay 2 reporting itself as an A1 with a camera, as the printer list and its status give it. */
function asA1(h: Awaited<ReturnType<typeof connect>>) {
  const host = h.ctx.printers!.host
  const list = host.list.bind(host)
  const status = host.status.bind(host)
  Object.assign(host, {
    list: async () => (await list()).map((p) => (p.id === 'bay-2' ? { ...p, name: 'A1', model: 'A1' } : p)),
    status: async (id: string) => {
      const s = await status(id)
      return id === 'bay-2' ? { ...s, model: 'A1', cameraAvailable: true } : s
    },
  })
}

describe('slicerx_printer_queue to a Bambu Lab printer', () => {
  it('hands the hub a .gcode.3mf with the slots matched to what is loaded, and reads the map back', async () => {
    // Bay 2 is a P1S with purple PLA in A1 and green PLA in A2: a green plate goes to A2.
    const { h, sent } = await sliced({ color: '#22C55E' })
    const r = await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1 })
    expect(r.isError, text(r)).toBeFalsy()
    const a = data<Answer>(r)
    expect(a.status).toBe('needs_person')
    expect(a.slot_map).toEqual({ 0: 'A2' })
    expect(a.file).toMatch(/\.gcode\.3mf$/)
    expect(a.lines).toContain('Filament slots: filament 1 from slot A2 (matched to what is loaded)')
    expect(text(r)).toContain('filament 1 from slot A2')

    const w = sent[0]?.work
    if (w?.kind !== 'print') throw new Error('expected print work')
    expect(w.file.kind).toBe('gcode.3mf')
    expect(w.opts).toEqual({ ...P1S, slotMap: { 0: 'A2' } })
    // The card the person approves binds the same file and the same map.
    const start = await hashParams({ printerId: 'bay-2', name: w.file.name, opts: w.opts, sha256: w.file.sha256 })
    expect(sent[0]?.request.actions[1]).toEqual({ action: 'printer.start', target: 'bay-2', paramsHash: start })
    // A project the printer starts with project_file: the plate's G-code and its slice info.
    const zip = readZip(Buffer.from(w.file.data))
    expect(zip.names()).toEqual(expect.arrayContaining(['Metadata/plate_1.gcode', 'Metadata/plate_1.gcode.md5', 'Metadata/slice_info.config', 'Metadata/model_settings.config']))
    expect(zip.text('Metadata/slice_info.config')).toContain('<filament id="1" tray_info_idx="" type="PLA" color="#22C55E"')
    // The stub engine's output stays off printers inside a .gcode.3mf too.
    expect(stubOutput(w.file)).toBe(true)
  })

  it("sends the client's slot map over the match", async () => {
    const { h, sent } = await sliced({ color: '#22C55E' })
    const a = data<Answer>(await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1, slotMap: { '0': 'A1' } }))
    expect(a.status).toBe('needs_person')
    expect(a.slot_map).toEqual({ 0: 'A1' })
    expect(a.lines).toContain('Filament slots: filament 1 from slot A1')
    const w = sent[0]?.work
    expect(w?.kind === 'print' ? w.opts : null).toEqual({ ...P1S, slotMap: { 0: 'A1' } })
  })

  it('refuses a plate with no loaded slot of its material, before any card, in words to pass on', async () => {
    const { h, sent } = await sliced({ type: 'petg' })
    const r = await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1 })
    expect(r.isError).toBe(true)
    expect(data<{ error: { code: string; message: string } }>(r).error).toEqual({
      code: 'no_matching_slot',
      message: 'Bay 2 has no loaded slot of the right material for filament 1 (PETG): load it in the AMS or on the external spool and send again, or pass slotMap to pick the slots.',
    })
    expect(sent).toEqual([])
  })

  it('refuses two filaments in one slot', async () => {
    const { h, sent } = await sliced()
    const r = await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1, slotMap: { '0': 'A1', '1': 'A1' } })
    expect(r.isError).toBe(true)
    expect(data<{ error: { code: string } }>(r).error.code).toBe('duplicate_slot')
    expect(sent).toEqual([])
  })
})

describe('slicerx_printer_queue print options on an A1', () => {
  it("hands the hub the client's options over the A1's defaults, lists every one on the card and reads them back", async () => {
    const { h, sent } = await sliced()
    asA1(h)
    const r = await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1, options: { timelapse: true, bedLeveling: false } })
    expect(r.isError, text(r)).toBeFalsy()
    const a = data<Answer>(r)
    expect(a.status).toBe('needs_person')
    // An A1 starts with flow dynamics calibration on and vibration compensation off, and has no first layer inspection.
    const options = { bedLeveling: false, flowCalibration: true, vibrationCompensation: false, timelapse: true }
    expect(a.options).toEqual(options)
    expect(a.lines).toEqual(expect.arrayContaining(['Bed leveling: off', 'Flow dynamics calibration: on', 'Vibration compensation: off', 'Timelapse: on']))
    expect(a.lines.join(' ')).not.toContain('First layer inspection')
    expect(text(r)).toContain('- Timelapse: on')
    const w = sent[0]?.work
    if (w?.kind !== 'print') throw new Error('expected print work')
    expect(w.opts).toEqual({ ...options, slotMap: { 0: 'A1' } })
    // The start the person approves is bound to exactly these options.
    const start = await hashParams({ printerId: 'bay-2', name: w.file.name, opts: w.opts, sha256: w.file.sha256 })
    expect(sent[0]?.request.actions[1]).toEqual({ action: 'printer.start', target: 'bay-2', paramsHash: start })
    // The list a client checks reads the same options back.
    const pending = data<{ pending: { request_id: string; options?: Record<string, boolean>; lines: string[] }[] }>(await h.call('slicerx_pending_approvals', {})).pending
    expect(pending.find((p) => p.request_id === a.request_id)).toMatchObject({ options, lines: expect.arrayContaining(['Timelapse: on']) })
  })

  it("sends the A1's own defaults when the client names no options", async () => {
    const { h, sent } = await sliced()
    asA1(h)
    const a = data<Answer>(await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1 }))
    expect(a.options).toEqual({ bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: false })
    expect(a.lines).toContain('Timelapse: off')
    const w = sent[0]?.work
    expect(w?.kind === 'print' ? w.opts : null).toEqual({ bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: false, slotMap: { 0: 'A1' } })
  })

  it('refuses first layer inspection on an A1 before any card, naming the options it has', async () => {
    const { h, sent } = await sliced()
    asA1(h)
    const r = await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1, options: { firstLayerInspection: true } })
    expect(r.isError).toBe(true)
    expect(data<{ error: { code: string; message: string } }>(r).error).toEqual({
      code: 'unsupported_option',
      message: 'A1 has no first layer inspection, so nothing was sent: leave it out of options. It offers bed leveling, flow dynamics calibration, vibration compensation and timelapse.',
    })
    expect(sent).toEqual([])
  })

  it('refuses an option name the Print sheet does not have', async () => {
    const { h, sent } = await sliced()
    asA1(h)
    const r = await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1, options: { timeLapse: true } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/timeLapse/)
    expect(sent).toEqual([])
  })
})

describe('slicerx_printer_queue to a printer that takes filament as the G-code says', () => {
  it('hands the hub the plain G-code with no slot map, as before', async () => {
    const { h, sent } = await sliced()
    const a = data<Answer>(await h.call('slicerx_printer_queue', { printerId: 'bay-4', plate: 1 }))
    expect(a.status).toBe('needs_person')
    expect(a.slot_map).toBeUndefined()
    expect(a.file).toMatch(/\.gcode$/)
    const w = sent[0]?.work
    if (w?.kind !== 'print') throw new Error('expected print work')
    expect(w.file.kind).toBe('gcode')
    expect(w.opts).toEqual({})
    expect(stubOutput(w.file)).toBe(true)
  })
})
