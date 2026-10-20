// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's print run read back by MCP clients: the app's answer passed on field for field, nothing else it might carry
// (never the file, its SHA-256, a card's token or request id, an access code or a serial), safe defaults for an answer
// of the wrong shape, plain refusals without the app, and a print a client queues still waiting for the person.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRequest } from '@slicerx/contracts'
import type { AgentWork } from '@slicerx/pilot'
import { describe, expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { mimirRunTools, pick, type RunState } from '../src/mimir-run'
import { connect, data, text } from './helpers'

// What the app answers while a sliced and sent plate prints on Bay 2.
const PRINTING: RunState = {
  sessionId: 'mimir_a',
  steps: [
    { name: 'design', state: 'done' },
    { name: 'plate', state: 'done' },
    { name: 'target', state: 'done' },
    { name: 'slice', state: 'done' },
    { name: 'send', state: 'done' },
    { name: 'print', state: 'now' },
  ],
  slice: { timeS: 3720, grams: 41.5, cost: 0.83, warnings: ['Thin wall on the clip'], stale: false },
  send: { printerName: 'Bay 2', fileName: 'Bracket_plate_1.gcode.3mf', slots: [{ filament: 1, slot: 'A2' }, { filament: 2, slot: 'A3' }] },
  print: { printerName: 'Bay 2', state: 'printing', layer: 12, layerCount: 140, timeLeftS: 3100, progress: 9, outcome: null },
}

const SERIAL = '01P00A451200789'
const SHA = 'f'.repeat(64)

const run = (link: AppLinkCaller | undefined, input: Record<string, unknown> = {}) => {
  const t = mimirRunTools(link, 'SlicerX')[0]!
  return t.run(t.input.parse(input) as never, {} as never)
}
const answering = (value: unknown) => {
  const call = vi.fn(async () => value)
  return { call, link: { call: call as AppLinkCaller['call'] } }
}
const failing = (code: string, message = 'refused') => ({ call: (async () => { throw Object.assign(new Error(message), { code }) }) as AppLinkCaller['call'] })

describe('slicerx_mimir_run', () => {
  it('read-back follows the run', async () => {
    const { call, link } = answering(PRINTING)
    const out = await run(link)
    expect(call).toHaveBeenCalledWith('mimir.run', {})
    expect(out.output).toEqual(PRINTING)
    expect(out.summary).toBe('mimir session mimir_a in SlicerX: printing on Bay 2, layer 12 of 140, 9%, 52 min left. Done: design, plate, target, slice, send; now: print. Last slice: 1 h 2 min, 41.5 g, 1 warning.')

    const finished = await run(answering({ ...PRINTING, steps: PRINTING.steps.map((s) => ({ ...s, state: 'done' })), print: { ...PRINTING.print, state: 'finished', layer: 140, timeLeftS: 0, progress: 100, outcome: 'finished' } }).link)
    expect(finished.summary).toBe('mimir session mimir_a in SlicerX: the print on Bay 2 finished. Done: design, plate, target, slice, send, print. Last slice: 1 h 2 min, 41.5 g, 1 warning.')

    const fresh = await run(answering({ sessionId: 'mimir_b', steps: PRINTING.steps.map((s, i) => ({ ...s, state: i === 0 ? 'now' : 'todo' })), slice: null, send: null, print: null }).link)
    expect(fresh.summary).toBe('mimir session mimir_b in SlicerX: nothing sent to a printer yet. Now: design. Not sliced yet.')

    const stale = await run(answering({ ...PRINTING, slice: { ...PRINTING.slice, stale: true }, send: null, print: null }).link)
    expect(stale.summary).toContain('the plate, printer or slots changed after it, so slice again before sending')

    // before the tab first opens there is no run to read
    const none = await run(answering(null).link)
    expect(none.output).toBeNull()
    expect(none.summary).toBe('The mimir tab in SlicerX has not opened yet, so there is no print run to read.')
  })

  it('sessionId picks that chat', async () => {
    const { call, link } = answering(PRINTING)
    const out = await run(link, { sessionId: 'mimir_a' })
    expect(call).toHaveBeenCalledWith('mimir.run', { sessionId: 'mimir_a' })
    expect((out.output as RunState).sessionId).toBe('mimir_a')
    await expect(run(failing('not_found', 'no mimir session mimir_x'), { sessionId: 'mimir_x' })).rejects.toMatchObject({ code: 'not_found', message: 'no mimir session mimir_x' })
    expect(() => mimirRunTools(undefined, 'SlicerX')[0]!.input.parse({ sessionId: '' })).toThrow()
  })

  it('a wrong-shaped answer reads as safe defaults', async () => {
    for (const bad of [null, undefined, 'mimir', 42, []]) expect(pick(bad), JSON.stringify(bad)).toBeNull()
    const none = { sessionId: '', steps: [], slice: null, send: null, print: null }
    for (const bad of [{}, { sessionId: 7, steps: 'all', slice: 'yes', send: [], print: 1 }]) expect(pick(bad), JSON.stringify(bad)).toEqual(none)
    const odd = pick({
      sessionId: 'mimir_a',
      steps: [{ name: 'design', state: 'done' }, { name: 'design', state: 'now' }, { name: 'launch', state: 'done' }, { name: 'slice', state: 'maybe' }, null, { name: 'print', state: 'now' }],
      slice: { timeS: -5, grams: 'heavy', cost: Number.NaN, warnings: ['ok', 3, 'x'.repeat(400)], stale: 'no' },
      send: { printerName: 42, fileName: 'a.gcode', slots: [{ filament: 1, slot: 'A1' }, { filament: 0, slot: 'A2' }, { filament: 2.5, slot: 'A3' }, { filament: 3 }] },
      print: { printerName: 'Bay 2', state: 'launching', layer: 1.5, layerCount: -1, timeLeftS: null, progress: 140, outcome: 'exploded' },
    })!
    expect(odd.steps).toEqual([{ name: 'design', state: 'done' }, { name: 'print', state: 'now' }])
    expect(odd.slice).toEqual({ timeS: 0, grams: 0, cost: 0, warnings: ['ok', `${'x'.repeat(300)}...`], stale: false })
    expect(odd.send).toEqual({ printerName: '', fileName: 'a.gcode', slots: [{ filament: 1, slot: 'A1' }] })
    expect(odd.print).toEqual({ printerName: 'Bay 2', state: '', layer: null, layerCount: null, timeLeftS: null, progress: null, outcome: null })
    // run never fails on it either
    const out = await run(answering({ steps: 'all' }).link)
    expect(out.output).toEqual(none)
  })

  it('no sha256, request id or token leaves the app', async () => {
    // an app that wrongly sent the whole record and the card behind it: none of it reaches the client
    const leaky = {
      ...PRINTING,
      printerId: SERIAL,
      requestId: 'req_7f3a',
      token: 'tok_secret_123',
      slice: { ...PRINTING.slice, sliceId: 'slice_9', fingerprint: 'fp_1' },
      send: { ...PRINTING.send, printerId: SERIAL, sha256: SHA, data: 'UEsDBBQAAAAIAAAAIQ', requestId: 'req_7f3a', approvalToken: 'tok_secret_123', slots: [{ filament: 1, slot: 'A2', serial: SERIAL }] },
      print: { ...PRINTING.print, serial: SERIAL, accessCode: '12345678', host: '192.168.1.42', requestId: 'req_7f3a' },
      card: { requestId: 'req_7f3a', token: 'tok_secret_123', actions: [{ action: 'printer.start', paramsHash: SHA }] },
    }
    const out = await run(answering(leaky).link)
    expect(out.output).toEqual({ ...PRINTING, send: { ...PRINTING.send, slots: [{ filament: 1, slot: 'A2' }] } })
    const all = JSON.stringify(out)
    for (const secret of [SHA, SERIAL, 'req_7f3a', 'tok_secret_123', '12345678', 'UEsDBBQ', '192.168.1.42', 'sha256', 'fingerprint', 'sliceId', 'printerId', 'token', 'requestId', 'accessCode', 'serial', 'card']) {
      expect(all, secret).not.toContain(secret)
    }
  })

  it("an integrator's printer.queue still waits for the person", async () => {
    // A client that slices and queues gets a card for the person, handed to the hub with its work; nothing it can
    // call answers that card. The read-back is a read with no approval of its own.
    const h = await connect()
    const sent: { request: ApprovalRequest; work: AgentWork }[] = []
    h.ctx.gate.handOff = { register: async (request, work) => void sent.push({ request, work }), onDone: () => () => undefined }
    await h.call('slicerx_project_open', { name: 'Brackets', printer: 'bambu_p1s', filament: 'pla' })
    await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 1 })
    const s = await h.call('slicerx_slice', {})
    expect(s.isError, text(s)).toBeFalsy()
    const q = await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1 })
    expect(q.isError, text(q)).toBeFalsy()
    expect(data<{ status: string }>(q).status).toBe('needs_person')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.request.actions.map((a) => a.action)).toContain('printer.start')

    // the client's own approve can only decline a card the person keeps
    const id = data<{ request_id: string }>(q).request_id
    const approve = await h.call('slicerx_approve', { request_id: id, approve: true })
    expect(approve.isError).toBe(true)
    expect(JSON.stringify(approve)).toContain('needs_person')
    expect((await h.client.listTools()).tools.map((t) => t.name)).toContain('slicerx_mimir_run')
    const tool = mimirRunTools(undefined, 'SlicerX')[0]!
    expect(tool.permission).toBe('read')
    expect(tool.agentWork).toBeUndefined()
    expect(tool.approval).toBeUndefined()
  })

  it('TOOLS.md is current', () => {
    const doc = readFileSync(join(__dirname, '../TOOLS.md'), 'utf8')
    expect(doc).toContain('| `slicerx_mimir_run` |  |  | read |')
    expect(doc).toContain('never the file, its SHA-256, a card')
  })

  it('refuses plainly without the app', async () => {
    await expect(run(undefined)).rejects.toMatchObject({ code: 'not_configured', message: /--printers link/ })
    for (const code of ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']) await expect(run(failing(code))).rejects.toMatchObject({ code: 'not_configured' })
    await expect(run(failing('bad_request', 'unknown method mimir.run'))).rejects.toMatchObject({ code: 'not_configured' })
    await expect(run(failing('internal', 'the app broke'))).rejects.toMatchObject({ code: 'internal_error', message: 'the app broke' })
  })
})
