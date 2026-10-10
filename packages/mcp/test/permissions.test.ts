// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRequest } from '@slicerx/contracts'
import { hashParams } from '@slicerx/contracts'
import type { AgentWork } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { needsPerson } from '../src/gate'
import { connect, data, text } from './helpers'

const temp = { printerId: 'bay-4', heater: 'nozzle', celsius: 210 }
// Pausing bay-1 (printing in the demo fleet) is an action MCP may approve: it stops a printer.
const pause = { printerId: 'bay-1' }

function log(h: Awaited<ReturnType<typeof connect>>): { tool: string; decision: string; by?: string }[] {
  return data<{ entries: { tool: string; decision: string; by?: string }[] }>({ content: [], structuredContent: { entries: h.ctx.gate.log.recent(100) } }).entries
}

describe('Ask first without elicitation', () => {
  it('returns an approval request and does nothing until approved', async () => {
    const h = await connect()
    const r = await h.call('slicerx_printer_pause', pause)
    const req = data<{ status: string; request_id: string; title: string }>(r)
    expect(req.status).toBe('approval_required')
    expect(req.title).toMatch(/Bay 1|bay-1/)
    expect(text(r)).toMatch(/slicerx_approve/)
    expect(log(h).at(-1)).toMatchObject({ tool: 'printer.pause', decision: 'pending' })

    const pending = data<{ pending: { request_id: string }[] }>(await h.call('slicerx_pending_approvals'))
    expect(pending.pending.map((p) => p.request_id)).toEqual([req.request_id])

    const done = await h.call('slicerx_approve', { request_id: req.request_id, approve: true })
    expect(done.isError, text(done)).toBeFalsy()
    expect(log(h).at(-1)).toMatchObject({ decision: 'approved', by: 'client' })
    expect(data<{ output: { state: string } }>(await h.call('slicerx_printer_status', pause)).output.state).toBe('paused')
  })

  it('uses a request once', async () => {
    const h = await connect()
    const { request_id } = data<{ request_id: string }>(await h.call('slicerx_printer_pause', pause))
    await h.call('slicerx_approve', { request_id, approve: true })
    const again = await h.call('slicerx_approve', { request_id, approve: true })
    expect(again.isError).toBe(true)
  })

  it('records a decline and changes nothing', async () => {
    const h = await connect()
    const { request_id } = data<{ request_id: string }>(await h.call('slicerx_printer_cancel', pause))
    const r = await h.call('slicerx_approve', { request_id, approve: false })
    expect(data<{ status: string }>(r).status).toBe('denied')
    expect(log(h).at(-1)).toMatchObject({ decision: 'denied', by: 'client' })
    expect(data<{ output: { state: string } }>(await h.call('slicerx_printer_status', pause)).output.state).toBe('printing')
  })

  it('expires requests after five minutes', async () => {
    let t = Date.parse('2026-09-30T12:00:00Z')
    const h = await connect({ now: () => t })
    const { request_id } = data<{ request_id: string }>(await h.call('slicerx_printer_pause', pause))
    t += 5 * 60 * 1000 + 1
    const r = await h.call('slicerx_approve', { request_id, approve: true })
    expect(text(r)).toMatch(/expired/)
    expect(log(h).at(-1)).toMatchObject({ decision: 'expired' })
  })
})

describe('Ask first with elicitation', () => {
  it('asks the user and runs on approval', async () => {
    const asked: string[] = []
    const h = await connect({}, { elicit: (m) => (asked.push(m), true) })
    const r = await h.call('slicerx_printer_pause', pause)
    expect(r.isError, text(r)).toBeFalsy()
    expect(asked[0]).toMatch(/Pause the print/)
    expect(log(h).at(-1)).toMatchObject({ decision: 'approved', by: 'user' })
  })

  it('stops when the user declines', async () => {
    const h = await connect({}, { elicit: () => false })
    const r = await h.call('slicerx_printer_cancel', pause)
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/declined/)
    expect(log(h).at(-1)).toMatchObject({ decision: 'denied', by: 'user' })
  })
})

describe('a person approves anything that moves or heats a printer', () => {
  const moving: [string, Record<string, unknown>][] = [
    ['slicerx_printer_set_temperature', temp],
    ['slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' }],
    ['slicerx_printer_resume', { printerId: 'bay-3' }],
  ]

  it.each(moving)('%s can only wait for a person', async (tool, args) => {
    const asked: string[] = []
    const h = await connect({}, { elicit: (m) => (asked.push(m), true) })
    const r = await h.call(tool, args)
    const req = data<{ status: string; request_id: string }>(r)
    expect(req.status).toBe('needs_person')
    expect(text(r)).toMatch(/in SlicerX or on the phone/)
    expect(asked).toEqual([])
    expect(log(h).at(-1)).toMatchObject({ decision: 'needs_person' })

    const tried = await h.call('slicerx_approve', { request_id: req.request_id, approve: true })
    expect(tried.isError).toBe(true)
    expect(text(tried)).toMatch(/cannot be approved through MCP/)
    expect(log(h).at(-1)).toMatchObject({ decision: 'refused', by: 'client' })
  })

  it('holds the same person-only actions as the hub', () => {
    // sx-link roles.rs PERSON_ONLY, and Home Assistant calls, which switch power.
    const card = (action: string, target = 'bay-4') => ({ actions: [{ action, target, paramsHash: 'a'.repeat(64) }] }) as Pick<ApprovalRequest, 'actions'>
    for (const a of ['printer.start', 'printer.resume', 'printer.gcode', 'printer.adjust']) expect(needsPerson(card(a)), a).toBe(true)
    expect(needsPerson(card('plugin.call', 'home-assistant'))).toBe(true)
    expect(needsPerson(card('plugin.call', 'spoolman'))).toBe(false)
    expect(needsPerson(card('printer.pause'))).toBe(false)
  })

  it('lets the client decline a request that waits for a person', async () => {
    const h = await connect()
    const { request_id } = data<{ request_id: string }>(await h.call('slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' }))
    expect((await h.call('slicerx_approve', { request_id, approve: true })).isError).toBe(true)
    const r = await h.call('slicerx_approve', { request_id, approve: false })
    expect(data<{ status: string }>(r).status).toBe('denied')
    const pending = data<{ pending: unknown[] }>(await h.call('slicerx_pending_approvals'))
    expect(pending.pending).toEqual([])
  })

  it('is not lifted by Allow in the policy file', async () => {
    const h = await connect({ policy: { classes: { slice: 'allow', queue: 'allow', start: 'ask', profile: 'ask' }, printers: { 'bay-4': { start: 'allow' }, 'bay-3': { start: 'allow' } } } })
    expect(data<{ status: string }>(await h.call('slicerx_printer_set_temperature', temp)).status).toBe('needs_person')
    expect(data<{ status: string }>(await h.call('slicerx_printer_resume', { printerId: 'bay-3' })).status).toBe('needs_person')
  })
})

describe('person-only work goes to the hub', () => {
  function fakeHub(h: Awaited<ReturnType<typeof connect>>, fail?: string, partner?: boolean) {
    const sent: { request: ApprovalRequest; work: AgentWork }[] = []
    h.ctx.gate.handOff = {
      ...(partner ? { partner: true } : {}),
      register: async (request, work) => {
        if (fail) throw new Error(fail)
        sent.push({ request, work })
      },
      onDone: () => () => undefined,
    }
    return sent
  }

  it('sends the card with its G-code work, and records how the hub ran it', async () => {
    const h = await connect()
    const sent = fakeHub(h)
    const req = data<{ status: string; request_id: string }>(await h.call('slicerx_printer_set_temperature', temp))
    expect(req.status).toBe('needs_person')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.work).toEqual({ kind: 'gcode', printerId: 'bay-4', line: 'M104 S210' })
    // The card lists exactly the call the work makes, as the hub checks.
    expect(sent[0]?.request.actions).toEqual([{ action: 'printer.gcode', target: 'bay-4', paramsHash: await hashParams({ printerId: 'bay-4', line: 'M104 S210' }) }])
    expect(sent[0]?.request.origin).toBe('mcp')

    const waiting = data<{ pending: { request_id: string; status: string }[] }>(await h.call('slicerx_pending_approvals'))
    expect(waiting.pending).toEqual([expect.objectContaining({ request_id: req.request_id, status: 'waiting_for_person' })])
    h.ctx.gate.waiting?.get(req.request_id)?.({ requestId: req.request_id, ok: true })
    const done = data<{ pending: { status: string }[] }>(await h.call('slicerx_pending_approvals'))
    expect(done.pending[0]?.status).toBe('done')
    expect(log(h).at(-1)).toMatchObject({ decision: 'approved', by: 'person' })
  })

  it('on a partner app key, a pause and a cancel also wait for a person, as pause and cancel work', async () => {
    const h = await connect()
    const sent = fakeHub(h, undefined, true)
    const p = data<{ status: string; request_id: string }>(await h.call('slicerx_printer_pause', pause))
    expect(p.status).toBe('needs_person')
    expect(sent[0]?.work).toEqual({ kind: 'pause', printerId: 'bay-1' })
    expect(sent[0]?.request.actions).toEqual([{ action: 'printer.pause', target: 'bay-1', paramsHash: await hashParams({ printerId: 'bay-1' }) }])
    expect((await h.call('slicerx_approve', { request_id: p.request_id, approve: true })).isError).toBe(true)
    await h.call('slicerx_printer_cancel', pause)
    expect(sent[1]?.work).toEqual({ kind: 'cancel', printerId: 'bay-1' })
    expect(data<{ output: { state: string } }>(await h.call('slicerx_printer_status', pause)).output.state).toBe('printing')
  })

  it('without a partner key, a pause stays approvable here', async () => {
    const h = await connect()
    const sent = fakeHub(h)
    expect(data<{ status: string }>(await h.call('slicerx_printer_pause', pause)).status).toBe('approval_required')
    expect(sent).toHaveLength(0)
  })

  it('sends a resume as resume work', async () => {
    const h = await connect()
    const sent = fakeHub(h)
    await h.call('slicerx_printer_resume', { printerId: 'bay-3' })
    expect(sent[0]?.work).toEqual({ kind: 'resume', printerId: 'bay-3' })
  })

  it('sends a queue-start with the file itself, matching the card', async () => {
    const h = await connect()
    const sent = fakeHub(h)
    await h.call('slicerx_project_open', { name: 'Brackets', printer: 'bambu_p1s', filament: 'pla' })
    await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 1 })
    await h.call('slicerx_slice', {})
    const q = data<{ status: string }>(await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1 }))
    expect(q.status).toBe('needs_person')
    const w = sent[0]?.work
    if (w?.kind !== 'print') throw new Error('expected print work')
    expect(w.file.data.byteLength).toBeGreaterThan(0)
    const upload = await hashParams({ printerId: 'bay-2', name: w.file.name, sha256: w.file.sha256 })
    expect(sent[0]?.request.actions[0]).toEqual({ action: 'printer.upload', target: 'bay-2', paramsHash: upload })
  })

  it('reports a hub that refuses the card', async () => {
    const h = await connect()
    fakeHub(h, 'the card does not match the work')
    const r = await h.call('slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/does not match the work/)
  })

  it('records a failed run', async () => {
    const h = await connect()
    fakeHub(h)
    const req = data<{ request_id: string }>(await h.call('slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' }))
    h.ctx.gate.waiting?.get(req.request_id)?.({ requestId: req.request_id, ok: false, code: 'offline', message: 'Bay 4 is offline' })
    const p = data<{ pending: { status: string; message?: string }[] }>(await h.call('slicerx_pending_approvals'))
    expect(p.pending[0]).toMatchObject({ status: 'failed', message: 'Bay 4 is offline' })
  })
})

describe('policy', () => {
  it('refuses a class that is Off', async () => {
    const h = await connect({ policy: { classes: { slice: 'allow', queue: 'ask', start: 'off', profile: 'ask' } } })
    const r = await h.call('slicerx_printer_set_temperature', temp)
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Off in the user's permission policy/)
    expect(log(h).at(-1)).toMatchObject({ decision: 'off', by: 'policy' })
  })

  it('never allows start for every printer, only per printer', async () => {
    const all = await connect({ policy: { classes: { slice: 'allow', queue: 'ask', start: 'allow', profile: 'ask' } } })
    expect(data<{ status: string }>(await all.call('slicerx_printer_pause', pause)).status).toBe('approval_required')
    const one = await connect({ policy: { classes: { slice: 'allow', queue: 'ask', start: 'ask', profile: 'ask' }, printers: { 'bay-1': { start: 'allow' } } } })
    const r = await one.call('slicerx_printer_pause', pause)
    expect(r.isError, text(r)).toBeFalsy()
    expect(log(one).at(-1)).toMatchObject({ decision: 'allowed', by: 'policy' })
  })

  it('shows the policy and has no tool to change it', async () => {
    const h = await connect()
    const p = data<{ classes: Record<string, { mode: string }> }>(await h.call('slicerx_get_policy'))
    expect(p.classes['buy']).toBeUndefined()
    expect(p.classes['start']?.mode).toBe('ask')
    const names = (await h.client.listTools()).tools.map((t) => t.name)
    expect(names.some((n) => /set_policy|policy_set/.test(n))).toBe(false)
  })

  it('refuses filament commands Bambu printers cannot take', async () => {
    const h = await connect()
    const r = await h.call('slicerx_printer_filament', { printerId: 'bay-2', action: 'load' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/AMS/)
  })

  it('keeps tokens out of the action log', async () => {
    const h = await connect()
    const { request_id } = data<{ request_id: string }>(await h.call('slicerx_printer_pause', pause))
    await h.call('slicerx_approve', { request_id, approve: true })
    const raw = readFileSync(h.ctx.gate.log.path, 'utf8')
    expect(raw).not.toMatch(/"token"/)
    expect(raw.trim().split('\n').length).toBeGreaterThanOrEqual(2)
  })
})

describe('project', () => {
  it('opens a project, adds a model and changes settings under the slice class', async () => {
    const h = await connect()
    const open = await h.call('slicerx_project_open', { name: 'Brackets', printer: 'bambu_p1s', filament: 'petg' })
    expect(open.isError).toBeFalsy()
    const add = data<{ output: { object: { bbox_mm: number[] } } }>(await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 4 }))
    expect(add.output.object.bbox_mm).toEqual([20, 20, 20])
    const set = await h.call('slicerx_project_set_overrides', { changes: { layer_height: 0.16 } })
    expect(set.isError).toBeFalsy()
    expect(log(h).at(-1)).toMatchObject({ tool: 'project.set_overrides', decision: 'allowed' })
    const bad = await h.call('slicerx_project_set_overrides', { changes: { layer_height: 9 } })
    expect(bad.isError).toBe(true)
  })

  it('slices the project and leaves the queue-start for a person to approve', async () => {
    const h = await connect()
    await h.call('slicerx_project_open', { name: 'Brackets', printer: 'bambu_p1s', filament: 'pla' })
    await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 2 })
    const sliced = await h.call('slicerx_slice', {})
    expect(sliced.isError, text(sliced)).toBeFalsy()
    const q = data<{ status: string; request_id: string }>(await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1 }))
    expect(q.status).toBe('needs_person')
    const r = await h.call('slicerx_approve', { request_id: q.request_id, approve: true })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/in SlicerX or on the phone/)
    expect(data<{ output: { state: string } }>(await h.call('slicerx_printer_status', { printerId: 'bay-2' })).output.state).toBe('idle')
  })
})

describe('build plate confirmation', () => {
  it('ignores bed_clear from slicerx_approve and says where to confirm the plate', async () => {
    const h = await connect()
    const req = data<{ request_id: string }>(await h.call('slicerx_printer_pause', pause))
    const r = await h.call('slicerx_approve', { request_id: req.request_id, approve: true, bed_clear: true })
    expect(r.isError, text(r)).toBeFalsy()
    const all = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(all).toMatch(/bed_clear was ignored/)
    expect(all).toMatch(/in SlicerX or on the phone/)
  })

  it('never grants a print start through MCP, whatever the client sends', async () => {
    const h = await connect()
    const broker = h.ctx.gate.broker as typeof h.ctx.gate.broker & { grantWith?: (id: string, o: { bedClear: boolean }) => Promise<unknown> }
    const granted: string[] = []
    const grant = broker.grant.bind(broker)
    broker.grant = async (id) => {
      granted.push(id)
      return grant(id)
    }
    broker.grantWith = async (id) => {
      granted.push(id)
      return grant(id)
    }
    await h.call('slicerx_project_open', { name: 'Brackets', printer: 'bambu_p1s', filament: 'pla' })
    await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 1 })
    await h.call('slicerx_slice', {})
    const q = await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1 })
    expect(text(q)).toMatch(/in SlicerX or on the phone/)
    expect(text(q)).not.toMatch(/bed_clear: true/)
    const id = data<{ request_id: string }>(q).request_id
    const r = await h.call('slicerx_approve', { request_id: id, approve: true, bed_clear: true })
    expect(r.isError).toBe(true)
    expect(granted).not.toContain(id)
  })
})

describe('service plugins', () => {
  it('reads Spoolman freely and asks before changing inventory', async () => {
    const h = await connect()
    const spools = await h.call('slicerx_spoolman_list_spools', { material: 'PLA' })
    expect(spools.isError, text(spools)).toBeFalsy()
    const r = data<{ status: string; request_id: string }>(await h.call('slicerx_spoolman_record_usage', { id: 1, grams: 12.5 }))
    expect(r.status).toBe('approval_required')
    const done = await h.call('slicerx_approve', { request_id: r.request_id, approve: true })
    expect(done.isError, text(done)).toBeFalsy()
  })
})

describe('extra tools', () => {
  it('gates tools added from outside the base kit', async () => {
    const { defineTool } = await import('@slicerx/pilot')
    const { z } = await import('zod')
    const cloudSlice = defineTool({
      name: 'cloud.send',
      version: '1.0.0',
      source: 'plugin',
      permission: 'queue',
      description: 'Offer a sliced file to a printer through the cloud (test double).',
      input: z.object({ printerId: z.string() }),
      async run(i) {
        return { summary: `offered to ${i.printerId}` }
      },
    })
    const h = await connect({ extraTools: [cloudSlice as never] })
    const r = data<{ status: string }>(await h.call('slicerx_cloud_send', { printerId: 'bay-2' }))
    expect(r.status).toBe('approval_required')
  })
})
