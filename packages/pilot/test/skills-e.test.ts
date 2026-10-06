// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ApprovalToken, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, createEvalSlicer } from '../evals/harness'
import { createFakeHosts, SETUP_REACHABLE_HOST, type FakeHosts } from '../evals/fakes'
import { runScenario } from '../evals/runner'
import { SCENARIOS } from '../evals/skills/e'
import { createScriptedClient } from '../src/provider/scripted'
import { buildApprovalRequest } from '../src/runtime'
import { toolSpec, type PilotTool, type ToolContext } from '../src/tool'
import { availableSkills } from '../skills/catalog'
import { create as batchA } from '../skills/batch-a'
import { createShared } from '../src/shared'
import { PRINTER_MODELS, connectionMethod } from '@slicerx/printer-catalog'
import { createSetupTools, findBrand, findModel } from '../skills/printer_setup/index'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const CONN = { family: 'bambu-lan', address: SETUP_REACHABLE_HOST, serial: '01P00A123456789' }
const P1S = { connection: CONN }
const ADD = { profileId: 'bambu-p1s', nozzleMm: 0.4, connection: CONN, name: 'Bay 1' }

function setup() {
  const holder: { fake?: FakeHosts } = {}
  const env = createEvalEnv({
    client: createScriptedClient([]),
    machine: MACHINE,
    objects: [],
    hosts: (e) => {
      holder.fake = createFakeHosts(e)
      return holder.fake.hosts
    },
  })
  const fake = holder.fake
  if (!fake) throw new Error('fake hosts missing')
  const tools = new Map(createSetupTools().map((t) => [t.name, t as unknown as PilotTool<Record<string, unknown>>]))
  const ctxFor = (callId: string, token?: ApprovalToken): ToolContext => {
    const ctx: ToolContext = {
      host: { printers: env.sim, slicer: createEvalSlicer(() => env.project), ...fake.hosts },
      sessionId: 's1',
      callId,
      signal: new AbortController().signal,
      context: { machine: MACHINE },
      today: '2026-09-30',
      project: env.project,
      kb: env.kb,
      progress: () => undefined,
    }
    if (token) ctx.token = token
    return ctx
  }
  const tool = (name: string): PilotTool<Record<string, unknown>> => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}`)
    return t
  }
  async function approve(name: string, input: Record<string, unknown>, callId = 'approve'): Promise<ApprovalToken> {
    const req = await buildApprovalRequest(tool(name), input, ctxFor(callId), { id: `apr_${name}_${callId}`, sessionId: 's1', expiresAt: new Date(Date.parse('2026-09-30T14:05:00Z')).toISOString() })
    await env.broker.register(req)
    return env.broker.grant(req.id)
  }
  const stage = async (input: Record<string, unknown>): Promise<{ stage: string; ask: { question: string; options?: { id: string; note?: string }[] }; resolved: Record<string, unknown> }> => {
    const out = await tool('printer_setup').run(input, ctxFor('c'))
    return out.output as never
  }
  return { env, fake, tool, ctxFor, approve, stage }
}

describe('printer setup scenarios replay', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s passes', async (_id, s) => {
    const rec = await runScenario(s, { mode: 'replay', model: 'scripted', run: 1 })
    expect({ pass: rec.score.pass, notes: rec.score.notes }).toMatchObject({ pass: true })
    expect(rec.score.unapprovedSideEffects).toBe(0)
  })
})

describe('catalog lookups', () => {
  it('finds a brand and a model in the printer catalog', () => {
    expect(findBrand('bambu').map((b) => b.id)).toEqual(['bambu-lab'])
    expect(findModel('bambu-lab', 'P1S').map((m) => m.id)).toEqual(['bambu-p1s'])
    expect(findModel('bambu-lab', 'A1').map((m) => m.id)).toEqual(['bambu-a1'])
  })

  it('does not match a model of another brand or a partial word', () => {
    expect(findModel('bambu-lab', 'MK4S')).toEqual([])
    expect(findModel('bambu-lab', 'P1')).toEqual([])
  })

  it('finds a PrusaLink printer and a Klipper printer with their connection', () => {
    expect(findModel('prusa', 'MK4S')[0]?.connections[0]).toBe('prusalink')
    expect(findBrand('sovol')).toHaveLength(1)
  })

  it('marks every access code, key and password field secret', () => {
    for (const m of PRINTER_MODELS) for (const c of m.connections) for (const f of connectionMethod(c).fields) if (['accessCode', 'apiKey', 'password'].includes(f.key)) expect(f.secret, `${m.id} ${c}`).toBe(true)
  })
})

describe('stages', () => {
  it('asks the look and feel first, then the brand', async () => {
    const { stage } = setup()
    const s = await stage({})
    expect(s.stage).toBe('look')
    expect(s.ask.options?.map((o) => o.id)).toEqual(['slicerx', 'bambu-studio', 'prusaslicer', 'orcaslicer'])
    expect((await stage({ skipLook: true })).stage).toBe('brand')
    expect((await stage({ look: 'slicerx' })).stage).toBe('brand')
  })

  it('walks brand, model, nozzle, connection, details, test, confirm', async () => {
    const { stage } = setup()
    const base = { skipLook: true }
    expect((await stage({ ...base, brand: 'Bambu Lab' })).stage).toBe('model')
    expect((await stage({ ...base, brand: 'Bambu Lab', model: 'P1S' })).stage).toBe('nozzle')
    const conn = await stage({ ...base, brand: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4 })
    expect(conn.stage).toBe('connection')
    expect(conn.ask.options?.map((o) => o.id)).toEqual(['bambu-lan', 'export'])
    const details = await stage({ ...base, brand: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4, connection: 'bambu-lan' })
    expect(details.stage).toBe('details')
    // the serial is optional: a printer added by address reads it from its certificate
    expect(details.ask.options?.map((o) => o.id)).toEqual(['host'])
    expect(details.ask.options?.find((o) => o.id === 'host')?.note).toMatch(/WLAN/)
    const test = await stage({ ...base, brand: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4, connection: 'bambu-lan', host: '10.0.0.5', serial: 'X' })
    expect(test.stage).toBe('test')
    const confirm = await stage({ ...base, brand: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4, connection: 'bambu-lan', host: '10.0.0.5', serial: 'X', tested: true })
    expect(confirm.stage).toBe('confirm')
  })

  it('never asks for a secret in the details stage', async () => {
    const { stage } = setup()
    const d = await stage({ skipLook: true, brand: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4, connection: 'bambu-lan' })
    expect(JSON.stringify(d)).not.toMatch(/"field":"accessCode"[^}]*"secret":false/)
    expect(d.ask.options?.some((o) => o.id === 'accessCode')).toBe(false)
  })

  it('skips the connection steps for slicing only and suggests calibration once added', async () => {
    const { stage } = setup()
    const base = { skipLook: true, brand: 'Prusa', model: 'MK4S', nozzleMm: 0.4, connection: 'export' }
    expect((await stage(base)).stage).toBe('confirm')
    const done = await stage({ ...base, added: true })
    expect(done.stage).toBe('calibrate')
  })

  it('offers only the sizes the model has', async () => {
    const { stage } = setup()
    const s = await stage({ skipLook: true, brand: 'Bambu Lab', model: 'A1 mini', nozzleMm: 1 })
    expect(s.stage).toBe('nozzle')
    expect(s.ask.options?.map((o) => o.id)).toEqual(['0.2', '0.4', '0.6', '0.8'])
  })
})

describe('changes ask first', () => {
  it('a connection test without a token does nothing', async () => {
    const { tool, ctxFor, fake } = setup()
    const out = await tool('printer_test').run(P1S, ctxFor('t1'))
    expect(out.ok).toBe(false)
    expect(fake.setup.tested).toEqual([])
  })

  it('an approval for one host does not cover another', async () => {
    const { tool, ctxFor, approve, fake } = setup()
    const token = await approve('printer_test', P1S)
    await expect(tool('printer_test').run({ connection: { ...CONN, address: '10.0.0.9' } }, ctxFor('t2', token))).rejects.toThrow(/refused/)
    expect(fake.setup.tested).toEqual([])
  })

  it('an approved test reports what the printer said and adds nothing', async () => {
    const { tool, ctxFor, approve, fake } = setup()
    const token = await approve('printer_test', P1S)
    const out = await tool('printer_test').run(P1S, ctxFor('t3', token))
    expect(out.ok).toBe(true)
    expect(fake.setup.added).toEqual([])
  })

  it('a failed test gives a hint and marks the output untrusted', async () => {
    const { tool, ctxFor, approve } = setup()
    const input = { connection: { ...CONN, address: '10.9.9.9' } }
    const token = await approve('printer_test', input)
    const out = await tool('printer_test').run(input, ctxFor('t4', token))
    expect(out.ok).toBe(false)
    expect(out.untrusted).toBe(true)
    expect((out.output as { hint: string; cause: string }).cause).toBe('unreachable')
    expect((out.output as { hint: string }).hint).toMatch(/LAN Only Mode/)
  })

  it('adding a printer needs the exact approved values', async () => {
    const { tool, ctxFor, approve, fake } = setup()
    const token = await approve('printer_add', ADD)
    await expect(tool('printer_add').run({ ...ADD, nozzleMm: 0.6 }, ctxFor('a1', token))).rejects.toThrow(/refused/)
    expect(fake.setup.added).toEqual([])
    const ok = await approve('printer_add', ADD, 'again')
    const out = await tool('printer_add').run(ADD, ctxFor('a2', ok))
    expect(fake.setup.added.map((a) => a.profileId)).toEqual(['bambu-p1s'])
    expect((out.output as { printerId: string }).printerId).toBe('printer-1')
  })

  it('the approval card names vendor, model, nozzle and address', async () => {
    const { tool, ctxFor } = setup()
    const plan = await tool('printer_add').approval!(ADD, ctxFor('card'))
    const text = plan.lines.join(' | ')
    expect(text).toContain('Bambu Lab P1S')
    expect(text).toContain('0.4 mm')
    expect(text).toContain(SETUP_REACHABLE_HOST)
  })

  it('discover and profile search are read only and report what the host has', async () => {
    const { tool, ctxFor } = setup()
    expect(tool('printer_discover').permission).toBe('read')
    expect(tool('printer_profile_search').permission).toBe('read')
    const found = await tool('printer_discover').run({}, ctxFor('d'))
    expect((found.output as { address: string }[])[0]?.address).toBe(SETUP_REACHABLE_HOST)
    const hits = await tool('printer_profile_search').run({ query: 'bambu p1s' }, ctxFor('p'))
    expect((hits.output as { id: string }[]).map((h) => h.id)).toEqual(['bambu-p1s'])
  })

  it('the tools always ask, even when their class is set to allow', async () => {
    const { tool, ctxFor } = setup()
    for (const n of ['printer_test', 'printer_add']) expect((await tool(n).mustAsk?.(P1S as never, ctxFor('m')))?.length, n).toBeGreaterThan(0)
  })

  it('the look changes only with a token', async () => {
    const { tool, ctxFor, approve, fake } = setup()
    expect((await tool('setup.look').run({ look: 'prusaslicer' }, ctxFor('l1'))).ok).toBe(false)
    const token = await approve('setup.look', { look: 'prusaslicer' })
    await tool('setup.look').run({ look: 'prusaslicer' }, ctxFor('l2', token))
    expect(fake.setup.looks).toEqual(['prusaslicer'])
  })
})

describe('tool definitions', () => {
  it('have no field that could carry a secret, and describe every input', () => {
    for (const t of createSetupTools()) {
      const spec = toolSpec(t)
      const props = (spec.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
      for (const [k, v] of Object.entries(props)) {
        expect(k, `${t.name}.${k}`).not.toMatch(/code|key|password|secret|token/i)
        expect(v.description, `${t.name}.${k}`).toBeTruthy()
      }
    }
  })

  it('the skill is offered when its tools are registered', () => {
    const names = new Set(batchA(createShared()).map((t) => t.name))
    const { ctxFor } = setup()
    const skills = ctxFor('s').kb.skills()
    expect(availableSkills(skills, (n) => names.has(n)).map((s) => s.id)).toContain('printer_setup')
  })
})
