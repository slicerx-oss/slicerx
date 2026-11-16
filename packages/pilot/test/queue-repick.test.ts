// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The spool the person picks on the send card: an approval that carries a slot map makes the same printer.queue send
// from that slot as a request of its own, granted by the person's answer, and turns the card's own request down. The
// printer starts from the picked slot and the run records it. A slot the printer does not report as loaded, or a map
// that does not fit the send the card showed, is refused with nothing sent and the record taken back.
import { pickedRequestId, type ApprovalDecision, type ApprovalRequest, type PilotEvent, type PilotMachine, type RemoteFile, type StartOptions } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, type EvalObject } from '../evals/harness'
import { createScriptedClient } from '../src/provider/scripted'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const CLIP: EvalObject = { id: 'clip', name: 'Clip', bboxMm: [30, 12, 8] }

type ToolResult = Extract<PilotEvent, { type: 'tool_result' }>
type ToolCall = Extract<PilotEvent, { type: 'tool_call' }>

/** Slices and queues on Bay 2 (a P1S with PLA in A1 and A2 and ASA in A3), answering the card with `decision`. */
async function send(decision: ApprovalDecision) {
  const host = { fingerprint: () => 'fp1' }
  const env = createEvalEnv({
    client: createScriptedClient([{ calls: [{ name: 'slice', args: {} }] }, { calls: [{ name: 'printer.queue', args: { printerId: 'bay-2', plate: 1 } }] }, { text: 'done' }]),
    machine: MACHINE,
    objects: [CLIP],
    printRun: host,
  })
  const registered: string[] = []
  const denied: string[] = []
  const broker = env.broker as unknown as { register(r: ApprovalRequest): Promise<void>; deny(id: string, reason?: string): Promise<void> }
  const register = broker.register.bind(broker)
  const deny = broker.deny.bind(broker)
  broker.register = async (r) => {
    registered.push(r.id)
    return register(r)
  }
  broker.deny = async (id, reason) => {
    denied.push(`${id}:${reason ?? ''}`)
    return deny(id, reason)
  }
  const starts: { file: RemoteFile; opts: StartOptions }[] = []
  const start = env.sim.start.bind(env.sim)
  env.sim.start = async (file, o, token) => {
    starts.push({ file, opts: o })
    return start(file, o, token)
  }
  const events: PilotEvent[] = []
  let card: ApprovalRequest | null = null
  for await (const ev of env.pilot.run('t', 'print it', { context: { machine: MACHINE } })) {
    events.push(ev)
    if (ev.type === 'approval_request') {
      card = ev.request
      await env.pilot.resolveApproval(ev.request.id, decision)
    }
  }
  const result = events.filter((e): e is ToolResult => e.type === 'tool_result').at(-1)
  const call = events.filter((e): e is ToolCall => e.type === 'tool_call').at(-1)
  const resolved = events.filter((e) => e.type === 'approval_resolved')
  return { env, events, card: card!, starts, result, call, resolved, registered, denied }
}

describe('a spool picked on the send card', () => {
  it('sends from the picked slot as a request of its own, and turns the card request down', async () => {
    const { card, starts, result, call, resolved, registered, denied, env } = await send({ kind: 'approve', bedClear: true, slotMap: { '0': 'A2' } })
    // the card itself showed the matched slot
    expect(card.lines).toContain('Filament slots: filament 1 from slot A1 (matched to what is loaded)')
    expect(registered).toEqual([card.id, pickedRequestId(card.id)])
    expect(denied).toEqual([`${card.id}:replaced`])
    // the person's answer resolves the card they answered
    expect(resolved).toEqual([{ type: 'approval_resolved', requestId: card.id, decision: { kind: 'approve', bedClear: true, slotMap: { '0': 'A2' } }, by: 'user' }])
    // the printer starts from the picked slot, and the call and its read-back say so
    expect(starts).toHaveLength(1)
    expect(starts[0]?.opts.slotMap).toEqual({ 0: 'A2' })
    expect(call?.input).toMatchObject({ printerId: 'bay-2', plate: 1, slotMap: { '0': 'A2' } })
    expect(result?.ok).toBe(true)
    expect(result?.output).toMatchObject({ slotMap: { '0': 'A2' }, slotMapSource: 'client' })
    // the run records the send from the picked slot (1 based, as the app shows it)
    expect(env.pilot.printRun!('t')?.send?.slots).toEqual({ 1: 'A2' })
  })

  it('a pick of the slot the card already showed is the card request itself', async () => {
    const { card, starts, registered, denied } = await send({ kind: 'approve', bedClear: true })
    expect(registered).toEqual([card.id])
    expect(denied).toEqual([])
    expect(starts[0]?.opts.slotMap).toEqual({ 0: 'A1' })
  })

  it('refuses a slot the printer does not report as loaded, with nothing sent and the record taken back', async () => {
    const { card, starts, result, resolved, denied, env, events } = await send({ kind: 'approve', bedClear: true, slotMap: { '0': 'A4' } })
    expect(starts).toEqual([])
    expect(env.audit.sideEffects).toEqual([])
    expect(denied).toEqual([`${card.id}:failed`])
    expect(resolved).toEqual([{ type: 'approval_resolved', requestId: card.id, decision: { kind: 'deny', reason: 'failed' }, by: 'user' }])
    // the step never ran: no row for it, and the model hears why
    expect(result?.summary).not.toMatch(/accepted/)
    const told = JSON.stringify(events.filter((e) => e.type === 'tool_call' && e.tool === 'printer.queue'))
    expect(told).toBe('[]')
    expect(env.pilot.printRun!('t')?.send).toBeNull()
  })

  it('refuses a map that does not fit the send the card showed', async () => {
    const { starts, resolved, env } = await send({ kind: 'approve', bedClear: true, slotMap: { '1': 'A2' } })
    expect(starts).toEqual([])
    expect(env.audit.sideEffects).toEqual([])
    expect(resolved.at(-1)).toMatchObject({ decision: { kind: 'deny', reason: 'failed' } })
  })
})
