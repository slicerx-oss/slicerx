// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's printer_setup skill behind the setup panel. The skill runs as chat tools; the ones
// that act (setup.look, printer_test, printer_add) raise an approval request, which the panel shows
// as a card. Apply resolves it, the broker grants a token, and the tool calls the SetupHost below,
// which verifies that token against the same broker before touching the form. The skill never sees
// a credential: the host adds it from the secure field on the form.
import { hashParams, type ApprovalToken, type ApprovalVerifier, type LookId, type Pilot, type SideEffectAction } from '@slicerx/contracts'
import type { SetupAddInput, SetupConnection, SetupHost, SetupTestResult } from '@slicerx/pilot'
import { modelById } from '@slicerx/printer-catalog'
import type { OnboardingPilot, PilotReply, PilotStatus, Proposal } from './pilot-adapter'
import { tileForModel } from './printer-form'
import type { AppSetupHost } from './setup-host'

/** What the pilot's SetupHost needs from the setup screen. */
export interface SetupBridge {
  currentLook(): LookId | null
  applyLook(id: LookId): void
  /** Fills the form with the connection and runs the screen's own test, with the secure field's credential. */
  test(connection: SetupConnection): Promise<SetupTestResult>
  /** Saves the printer with the secure field's credential and moves the flow on. */
  add(input: SetupAddInput): Promise<{ printerId: string }>
}

async function verifyOrThrow(verifier: ApprovalVerifier, token: ApprovalToken, action: SideEffectAction, target: string, params: unknown): Promise<void> {
  const r = await verifier.verify(token, action, target, await hashParams(params))
  if (!r.ok) throw new Error(`Not approved (${r.reason}). Nothing was changed.`)
}

/** The pilot-side SetupHost (packages/pilot/src/hosts.ts): reads pass through, every action verifies its token first. */
export function pilotSetupHost(verifier: ApprovalVerifier, setup: AppSetupHost, bridge: SetupBridge): SetupHost {
  return {
    discover: (opts) => setup.discover(opts),
    searchProfiles: (q) => setup.searchProfiles(q),
    async testConnection(connection, token) {
      const id = `probe:${connection.address}`
      await verifyOrThrow(verifier, token, 'printer.config', id, { printerId: id, changes: { probe: connection } })
      return bridge.test(connection)
    },
    async addPrinter(input, token) {
      const id = `new:${input.profileId}`
      await verifyOrThrow(verifier, token, 'printer.config', id, { printerId: id, changes: { add: input } })
      return bridge.add(input)
    },
    look: {
      current: async () => bridge.currentLook(),
      async apply(id, token) {
        await verifyOrThrow(verifier, token, 'profile.write', 'app:look-and-feel', { profileId: 'app:look-and-feel', changes: { look: id } })
        bridge.applyLook(id)
      },
    },
  }
}

/** Cards for what printer_setup resolved from the catalog. They still need Apply; nothing fills itself. */
function resolvedProposals(output: unknown, seen: Set<string>): Proposal[] {
  const resolved = (output as { resolved?: { model?: { id?: unknown }; nozzleMm?: unknown } } | null)?.resolved
  const out: Proposal[] = []
  const modelId = typeof resolved?.model?.id === 'string' ? resolved.model.id : null
  const model = modelId ? modelById(modelId) : undefined
  if (model && !seen.has(`model:${model.id}`)) {
    seen.add(`model:${model.id}`)
    const tile = tileForModel(model)
    out.push({ id: `r-${model.id}`, kind: 'set-model', brand: tile?.id ?? 'other', modelId: model.id, title: `Set printer to ${tile?.name ?? ''} ${model.name}`.replace(/\s+/g, ' ').trim() })
  }
  const nozzle = typeof resolved?.nozzleMm === 'number' ? resolved.nozzleMm : null
  if (nozzle && nozzle >= 0.1 && nozzle <= 2 && !seen.has(`nozzle:${nozzle}`)) {
    seen.add(`nozzle:${nozzle}`)
    out.push({ id: `r-n${nozzle}`, kind: 'set-nozzle', size: nozzle, type: 'brass', unsure: false, title: `Set nozzle to ${nozzle} mm` })
  }
  return out
}

/**
 * The panel's pilot on top of a Pilot with the printer_setup skill. `ask` streams the reply through
 * `onUpdate` and resolves when the run ends; a run waiting on an approval card stays open until the
 * card is applied or dismissed through `resolve`.
 */
export function createSkillPilot(pilot: Pilot, sessionId: string): OnboardingPilot {
  const seen = new Set<string>()
  let status: PilotStatus = 'ready'
  return {
    status: () => status,
    async ask(q, signal, onUpdate) {
      const form = Object.entries(q.form).map(([k, v]) => `${k}: ${v}`).join('; ')
      const message = `${q.text}\n\n[Setup step: ${q.step === 'look' ? 'look and feel' : 'printer'}. Form so far, secrets never included: ${form || 'empty'}.${q.lastTest ? ` Last test: ${q.lastTest.ok ? 'passed' : `failed (${q.lastTest.cause ?? 'unknown'})`}.` : ''}]`
      let reply: PilotReply = { text: '', proposals: [] }
      const push = (next: PilotReply) => {
        reply = next
        onUpdate?.(reply)
      }
      for await (const e of pilot.run(sessionId, message, signal ? { signal } : {})) {
        if (e.type === 'text') push({ ...reply, text: reply.text + e.delta })
        else if (e.type === 'approval_request') {
          push({ ...reply, proposals: [...reply.proposals, { id: e.request.id, kind: 'approval', requestId: e.request.id, title: e.request.title, lines: e.request.lines }] })
        } else if (e.type === 'tool_result' && e.ok) {
          const cards = resolvedProposals(e.output, seen)
          if (cards.length) push({ ...reply, proposals: [...reply.proposals, ...cards] })
        } else if (e.type === 'error') {
          if (/429|rate/i.test(e.message)) status = 'rate-limited'
          else if (/network|fetch|offline/i.test(e.message)) status = 'offline'
          push({ ...reply, text: `${reply.text}${reply.text ? '\n' : ''}${e.message}`, unsure: true })
        }
      }
      if (status !== 'ready' && reply.text && !reply.unsure) status = 'ready'
      return reply
    },
    async resolve(p, apply) {
      if (p.kind !== 'approval') return
      await pilot.resolveApproval(p.requestId, apply ? { kind: 'approve' } : { kind: 'deny', reason: 'Dismissed on the card' })
    },
  }
}
