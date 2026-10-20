// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// printer.queue and the print run: a slice made stale by a plate change is refused before any card on every path that
// has a run (MCP has none yet), and so is a slice the run did not record for that plate; the card's approval records the
// send, a card not approved takes it back, and a started print records the job. The record is never the permission.
import { hashParams, type ApprovalRequest, type PilotEvent, type PilotMachine, type RunSlice } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvalEnv, type EvalObject } from '../evals/harness'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import { createShared } from '../src/shared'
import { defineTool, type PilotTool, type ToolContext } from '../src/tool'
import { printerTools } from '../src/tools/printers'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const CLIP: EvalObject = { id: 'clip', name: 'Clip', bboxMm: [30, 12, 8] }

type ToolResult = Extract<PilotEvent, { type: 'tool_result' }>

const sliceOf = (fingerprint: string, stale = false): RunSlice => ({ sliceId: 'sl_1', plate: 1, at: '2026-10-20T00:00:00.000Z', timeS: 3600, grams: 12, cost: 0.3, warnings: [], fingerprint, stale })

/** The plate as the run host sees it: a test moves a part by changing the fingerprint. */
function plateHost() {
  const h = { fp: 'fp1', fingerprint: () => h.fp }
  return h
}

/** Test tools: one records another slice in the run than the one the slice skill made, one edits the plate after it. */
function runTools(host: { fp: string }): PilotTool<never>[] {
  const record = defineTool<Record<string, never>>({
    name: 'test.record_slice',
    version: '1',
    description: 'Records the slice in the run',
    source: 'skill',
    permission: 'read',
    input: z.object({}),
    async run(_i, ctx) {
      ctx.run?.update({ slice: sliceOf(host.fp) })
      return { summary: 'Recorded' }
    },
  })
  const edit = defineTool<Record<string, never>>({
    name: 'test.edit_plate',
    version: '1',
    description: 'Moves a part on the plate',
    source: 'skill',
    permission: 'read',
    input: z.object({}),
    async run() {
      host.fp = 'fp2'
      return { summary: 'Moved' }
    },
  })
  return [record, edit] as PilotTool<never>[]
}

async function drive(steps: ScriptStep[], opts: { answer?: 'approve' | 'deny' | 'none'; timeoutMs?: number; registerFails?: boolean } = {}) {
  const host = plateHost()
  const env = createEvalEnv({ client: createScriptedClient(steps), machine: MACHINE, objects: [CLIP], tools: runTools(host), printRun: host, ...(opts.timeoutMs !== undefined ? { approvalTimeoutMs: opts.timeoutMs } : {}) })
  // the broker refuses the card after the approval has recorded the send
  if (opts.registerFails) (env.broker as { register: (r: ApprovalRequest) => Promise<void> }).register = async () => Promise.reject(new Error('register failed'))
  const events: PilotEvent[] = []
  const cards: { request: ApprovalRequest; sendAtCard: unknown; builtin: boolean }[] = []
  for await (const ev of env.pilot.run('t', 'print it', { context: { machine: MACHINE } })) {
    events.push(ev)
    if (ev.type === 'approval_request') {
      cards.push({ request: ev.request, sendAtCard: env.pilot.printRun!('t')?.send ?? null, builtin: ev.builtin === true })
      const answer = opts.answer ?? 'approve'
      if (answer === 'approve') await env.pilot.resolveApproval(ev.request.id, { kind: 'approve', bedClear: true })
      else if (answer === 'deny') await env.pilot.resolveApproval(ev.request.id, { kind: 'deny', reason: 'canceled' })
    }
  }
  const results = events.filter((e): e is ToolResult => e.type === 'tool_result')
  return { env, events, cards, results }
}

const QUEUE = { calls: [{ name: 'printer.queue', args: { printerId: 'bay-2', plate: 1 } }] }
// the slice skill records its own slice in the run
const SLICED: ScriptStep[] = [{ calls: [{ name: 'slice', args: {} }] }]

describe('printer.queue and the print run', () => {
  it('a stale slice is refused before any card', async () => {
    const { env, cards, results } = await drive([...SLICED, { calls: [{ name: 'test.edit_plate', args: {} }] }, QUEUE, { text: 'done' }])
    expect(cards).toEqual([])
    const queued = results.at(-1)
    expect(queued?.ok).toBe(false)
    expect(queued?.summary).toBe('The plate changed after this slice. Slice it again.')
    expect(env.audit.sideEffects).toEqual([])
    expect(env.pilot.printRun!('t')?.send).toBeNull()
  })

  it('a slice the run did not record is refused before any card', async () => {
    // the run names slice sl_1 for plate 1, fresh, but the slice skill made another, which is what would be sent
    const { env, cards, results } = await drive([...SLICED, { calls: [{ name: 'test.record_slice', args: {} }] }, QUEUE, { text: 'done' }])
    expect(env.pilot.printRun!('t')?.slice).toMatchObject({ sliceId: 'sl_1', stale: false })
    expect(cards).toEqual([])
    const queued = results.at(-1)
    expect(queued?.ok).toBe(false)
    expect(queued?.summary).toBe('Plate 1 has no current slice in this chat, so nothing was sent. Slice it again.')
    expect(env.audit.sideEffects).toEqual([])
    expect(env.pilot.printRun!('t')?.send).toBeNull()
  })

  it('the approval records the send', async () => {
    const { cards } = await drive([...SLICED, QUEUE, { text: 'done' }])
    expect(cards).toHaveLength(1)
    // the runtime's own printer.queue, so the host may show its send card in place of the approval card
    expect(cards[0]!.request.tool).toBe('printer.queue')
    expect(cards[0]!.builtin).toBe(true)
    const upload = cards[0]!.request.actions.find((a) => a.action === 'printer.upload')!
    // recorded while the card is up, with the file the card binds (its hash is the upload's) and the slots it shows (1 based)
    const sent = cards[0]!.sendAtCard as { printerId: string; fileName: string; sha256: string }
    expect(sent).toMatchObject({ printerId: 'bay-2', fileKind: 'gcode.3mf', slots: { 1: 'A1' } })
    expect(sent.fileName).toMatch(/\.gcode\.3mf$/)
    expect(upload.paramsHash).toBe(await hashParams({ printerId: sent.printerId, name: sent.fileName, sha256: sent.sha256 }))
    const send = cards[0]!.sendAtCard as { timeS: number; grams: number }
    expect(send.timeS).toBeGreaterThan(0)
    expect(send.grams).toBeGreaterThan(0)
  })

  it('a started print records the job', async () => {
    const { env, results } = await drive([...SLICED, QUEUE, { text: 'done' }])
    expect(results.at(-1)?.ok, results.at(-1)?.summary).toBe(true)
    const job = env.pilot.printRun!('t')?.job
    expect(job).toMatchObject({ printerId: 'bay-2' })
    expect(job?.fileName).toMatch(/\.gcode\.3mf$/)
    // from the runtime clock: the eval clock starts at 2026-09-30T14:00Z
    expect(job?.startedAt.startsWith('2026-09-30T14:')).toBe(true)
    expect(job?.state).toBeTruthy()
  })

  it('a card that is not approved takes the send record back', async () => {
    const denied = await drive([...SLICED, QUEUE, { text: 'done' }], { answer: 'deny' })
    expect(denied.cards[0]?.sendAtCard).not.toBeNull()
    expect(denied.env.pilot.printRun!('t')?.send).toBeNull()
    expect(denied.env.audit.sideEffects).toEqual([])
    const expired = await drive([...SLICED, QUEUE, { text: 'done' }], { answer: 'none', timeoutMs: 50 })
    expect(expired.cards[0]?.sendAtCard).not.toBeNull()
    expect(expired.events.some((e) => e.type === 'approval_resolved' && e.by === 'expiry')).toBe(true)
    expect(expired.env.pilot.printRun!('t')?.send).toBeNull()
    expect(expired.env.audit.sideEffects).toEqual([])
  })

  it('a card the broker cannot register takes the send record back', async () => {
    const failed = await drive([...SLICED, QUEUE, { text: 'done' }], { registerFails: true })
    // no card was shown, the step failed, and the run does not still say a send is waiting
    expect(failed.cards).toEqual([])
    expect(failed.results.at(-1)?.ok).toBe(false)
    expect(failed.env.pilot.printRun!('t')?.send).toBeNull()
    expect(failed.env.audit.sideEffects).toEqual([])
  })

  // MCP has no chat run (packages/mcp/src/gate.ts), so the stale check does not apply there yet; logged for Task 11.
  it('printer.queue refuses a stale run on any path that has one, agentWork included', async () => {
    const queue = printerTools(createShared()).find((t) => t.name === 'printer.queue')!
    const stale = sliceOf('fp1', true)
    const ctx = {
      run: {
        get: () => ({ sessionId: 'mcp', designId: null, plate: 1, printerId: 'bay-2', slots: {}, slice: stale, send: null, job: null, updatedAt: '' }),
        update: () => {
          throw new Error('no writes')
        },
        recordSend: () => {
          throw new Error('no writes')
        },
        recordJob: () => {
          throw new Error('no writes')
        },
      },
    } as unknown as ToolContext
    const input = { printerId: 'bay-2', plate: 1 } as never
    await expect(queue.agentWork!(input, ctx)).rejects.toMatchObject({ code: 'stale_slice', message: 'The plate changed after this slice. Slice it again.' })
    await expect(queue.approval!(input, ctx)).rejects.toMatchObject({ code: 'stale_slice' })
  })
})
