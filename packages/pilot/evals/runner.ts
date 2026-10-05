// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs scenarios in replay (scripted provider) or live (configured model) mode
// and scores each run.
import type { PilotEvent } from '@slicerx/contracts'
import { createScriptedClient } from '../src/provider/scripted'
import type { LlmClient } from '../src/provider/types'
import { createEvalEnv, noteApprovals } from './harness'
import { score } from './score'
import type { RunRecord, Scenario } from './types'

export interface RunOptions {
  mode: 'replay' | 'live'
  /** Live mode: a client over the real transport. */
  liveClient?: () => LlmClient
  model: string
  run: number
  timeoutMs?: number
  onEvent?(ev: PilotEvent): void
}

export async function runScenario(s: Scenario, opts: RunOptions): Promise<RunRecord> {
  const inner = opts.mode === 'live' && opts.liveClient ? opts.liveClient() : createScriptedClient(s.script, { chunk: true })
  // Counts the images each request carried, so a scenario can check a frame reached the model.
  let imagesSeen = 0
  const client: LlmClient = {
    provider: inner.provider,
    stream(req, signal) {
      const n = req.messages.reduce((a, m) => a + (m.role === 'tool' ? (m.images?.length ?? 0) : 0), 0)
      imagesSeen = Math.max(imagesSeen, n)
      return inner.stream(req, signal)
    },
  }
  const envOpts: Parameters<typeof createEvalEnv>[0] = { client, machine: s.machine, objects: s.objects, model: opts.model }
  if (s.policy) envOpts.policy = s.policy
  if (s.fleet) envOpts.fleet = s.fleet
  if (s.hosts) envOpts.hosts = s.hosts
  if (s.frames) envOpts.frames = s.frames
  const env = createEvalEnv(envOpts)
  const events: PilotEvent[] = []
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? (opts.mode === 'live' ? 240_000 : 20_000))
  const t0 = performance.now()
  let error: string | undefined
  try {
    const stream = s.switchTo
      ? env.pilot.switchMachine(`eval-${s.id}`, s.machine, s.switchTo, { narrate: false, signal: ac.signal })
      : env.pilot.run(`eval-${s.id}`, s.prompt, {
          signal: ac.signal,
          context: { project: 'eval', machine: s.machine, objects: s.objects.map((o) => ({ id: o.id, name: o.name, bboxMm: o.bboxMm })) },
        })
    for await (const ev of stream) {
      events.push(ev)
      noteApprovals(env.audit, ev)
      opts.onEvent?.(ev)
      if (ev.type === 'approval_request') {
        const yes = s.approve?.(ev.request) ?? false
        void env.pilot.resolveApproval(ev.request.id, yes ? { kind: 'approve' } : { kind: 'deny', reason: 'not requested by the user' })
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    clearTimeout(timer)
  }
  const ms = performance.now() - t0
  const result = score(s, { events, overrides: env.project.appliedOverrides(), audit: env.audit, imagesSeen })
  if (error) result.notes.push(`error: ${error}`)
  const usage = events.filter((e): e is Extract<PilotEvent, { type: 'usage' }> => e.type === 'usage')
  const rec: RunRecord = {
    scenario: s.id,
    group: s.group,
    mode: opts.mode,
    model: opts.model,
    run: opts.run,
    score: result,
    toolCalls: events.filter((e) => e.type === 'tool_call').length,
    ms: Math.round(ms),
    inputTokens: usage.reduce((a, u) => a + u.inputTokens, 0),
    outputTokens: usage.reduce((a, u) => a + u.outputTokens, 0),
    calls: events.filter((e): e is Extract<PilotEvent, { type: 'tool_call' }> => e.type === 'tool_call').map((e) => e.tool),
    reply: events.map((e) => (e.type === 'text' ? e.delta : '')).join('').slice(0, 600),
  }
  if (error) rec.error = error
  return rec
}
