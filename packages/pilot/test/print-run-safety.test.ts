// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cannot start a print without the card (docs/safety.md). printer.queue waits for a person even when Start is
// set to Allow, a card nobody answers expires with nothing sent, and no tool can answer a card: the only way to resolve
// an approval is the runtime's resolveApproval, which only the person's click on the card calls.
import { DEFAULT_POLICY, type ApprovalHost, type ApprovalRequest, type JobFile, type PilotEvent, type PilotMachine, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createEvalEnv, type EvalObject } from '../evals/harness'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import { createCombinedPlanner } from '../src/kb/combined-planner'
import { createShared } from '../src/shared'
import type { ToolContext, ToolHost } from '../src/tool'
import { builtinTools } from '../src/tools'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const CLIP: EvalObject = { id: 'clip', name: 'Clip', bboxMm: [30, 12, 8] }
const SCRIPT: ScriptStep[] = [{ calls: [{ name: 'slice', args: {} }] }, { calls: [{ name: 'printer.queue', args: { printerId: 'bay-2', plate: 1 } }] }, { text: 'done' }]

/** The env with every upload the printers get counted. */
function envWith(opts: { allowStart?: boolean; timeoutMs?: number } = {}) {
  const env = createEvalEnv({
    client: createScriptedClient(SCRIPT),
    machine: MACHINE,
    objects: [CLIP],
    ...(opts.allowStart ? { policy: { ...DEFAULT_POLICY, classes: { ...DEFAULT_POLICY.classes, start: 'allow', queue: 'allow' } } } : {}),
    ...(opts.timeoutMs !== undefined ? { approvalTimeoutMs: opts.timeoutMs } : {}),
  })
  const uploads: string[] = []
  const starts: string[] = []
  const upload = env.sim.upload.bind(env.sim)
  const start = env.sim.start.bind(env.sim)
  env.sim.upload = async (id: string, file: JobFile, token) => {
    uploads.push(id)
    return upload(id, file, token)
  }
  env.sim.start = async (file, o, token) => {
    starts.push(file.printerId)
    return start(file, o, token)
  }
  return { env, uploads, starts }
}

describe('mimir cannot start a print without the card', () => {
  it('printer.queue under Allow still waits for a person', async () => {
    const { env, uploads, starts } = envWith({ allowStart: true })
    const events: PilotEvent[] = []
    let card: ApprovalRequest | null = null
    for await (const ev of env.pilot.run('t', 'print it', { context: { machine: MACHINE } })) {
      events.push(ev)
      if (ev.type === 'approval_request') {
        card = ev.request
        // the card is up and the run waits on it: nothing has reached the printer
        expect(uploads).toEqual([])
        expect(starts).toEqual([])
        expect(env.audit.sideEffects).toEqual([])
        await env.pilot.resolveApproval(ev.request.id, { kind: 'approve', bedClear: true })
      }
    }
    expect(card?.tool).toBe('printer.queue')
    // the policy did not answer it
    expect(events.some((e) => e.type === 'approval_resolved' && e.by === 'policy')).toBe(false)
    expect(events.some((e) => e.type === 'approval_resolved' && e.by === 'user')).toBe(true)
    // only after the person's answer did the file go
    expect(uploads).toEqual(['bay-2'])
    expect(starts).toEqual(['bay-2'])
  })

  it('an unanswered send card expires and nothing reaches the printer', async () => {
    const { env, uploads, starts } = envWith({ timeoutMs: 50 })
    const events: PilotEvent[] = []
    for await (const ev of env.pilot.run('t', 'print it', { context: { machine: MACHINE } })) events.push(ev)
    expect(events.some((e) => e.type === 'approval_request')).toBe(true)
    expect(events.some((e) => e.type === 'approval_resolved' && e.by === 'expiry')).toBe(true)
    expect(uploads).toEqual([])
    expect(starts).toEqual([])
    expect(env.audit.sideEffects).toEqual([])
  })

  it('no tool can resolve an approval', async () => {
    const { env } = envWith()
    const resolveApproval = vi.fn(env.pilot.resolveApproval.bind(env.pilot))
    env.pilot.resolveApproval = resolveApproval
    const grant = vi.fn(async () => {
      throw new Error('a tool tried to grant an approval')
    })
    // whatever a tool can reach: the host, its approvals and the printers; the spies sit on every way to an answer
    const approvals = { register: vi.fn(async () => undefined), grant, deny: vi.fn(async () => undefined), resolveApproval } as unknown as ApprovalHost
    const host = {
      printers: env.sim as unknown as PrinterHost,
      approvals,
      llm: { available: async () => true, stream: () => { throw new Error('no model here') } },
      pilot: env.pilot,
    } as unknown as ToolHost
    const tools = builtinTools({ planner: createCombinedPlanner(env.kb), commands: [], shared: createShared() })
    expect(tools.length).toBeGreaterThan(10)
    const ran: string[] = []
    for (const tool of tools) {
      const given = { printerId: 'bay-2', plate: 1, query: 'pla', name: 'x' }
      const parsed = tool.input.safeParse(given)
      const input = (parsed.success ? parsed.data : tool.input.safeParse({}).success ? tool.input.parse({}) : given) as never
      const ctx = {
        host,
        sessionId: 't',
        callId: `c_${tool.name}`,
        signal: new AbortController().signal,
        context: { machine: MACHINE },
        today: '2026-10-20',
        kb: env.kb,
        project: env.project,
        progress: () => undefined,
        ask: async () => {
          throw new Error('no asks here')
        },
        sheet: async () => {
          throw new Error('no sheets here')
        },
        bindSheet: () => false,
        // a forged token: a tool holding one still has no way to answer the card
        token: { requestId: 'apr_forged', token: 'forged', expiresAt: '2099-01-01T00:00:00.000Z' },
      } as unknown as ToolContext
      await Promise.race([tool.run(input, ctx).catch(() => undefined), new Promise((r) => setTimeout(r, 2000))])
      ran.push(tool.name)
    }
    expect(ran).toContain('printer.queue')
    expect(resolveApproval).not.toHaveBeenCalled()
    expect(grant).not.toHaveBeenCalled()
    // and the forged token moved no printer
    expect(env.audit.sideEffects.filter((x) => x.ok)).toEqual([])
  })
})
