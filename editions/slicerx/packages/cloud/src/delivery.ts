// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pulls cloud-sliced jobs to local printers. Runs wherever printers are
// reachable and a PrinterHost exists: the desktop app, or next to sx-link.
// It opens no ports; it long-polls the cloud service over an outbound
// connection. Nothing reaches a printer until the user approves the local
// approval card, which mints the token the printer host checks. The cloud
// never supplies or relays approval tokens.
import {
  type ApprovalDecision,
  type ApprovalHost,
  type ApprovalRequest,
  type ApprovalToken,
  type PrinterHost,
  hashParams,
} from '@slicerx/contracts'
import type { CloudClient } from './client'
import { isRetryable } from './result'
import type { Delivery } from './schemas'

export type DeliveryEvent =
  | { type: 'approval_needed'; delivery: Delivery; request: ApprovalRequest }
  | { type: 'printing'; delivery: Delivery }
  | { type: 'declined'; delivery: Delivery }
  | { type: 'failed'; delivery: Delivery; message: string }
  | { type: 'poll_error'; message: string }

export interface DeliveryAgentOptions {
  client: CloudClient
  /** This bridge's device id from `client.registerDevice`. */
  deviceId: string
  printers: Pick<PrinterHost, 'upload' | 'start'>
  approvals: Pick<ApprovalHost, 'register' | 'deny'>
  /** Maps the delivery's printer id on this bridge to the PrinterHost id; identity by default. */
  printerId?: (localId: string) => string | null
  onEvent?: (e: DeliveryEvent) => void
  /** Pilot session id the approval requests are filed under. */
  sessionId?: string
  /** How long an approval request stays open, default 30 minutes. */
  approvalTtlMs?: number
  now?: () => Date
}

export interface DeliveryAgent {
  /** Polls until `stop()`; resolves when stopped. */
  run(): Promise<void>
  stop(): void
  /** One poll and one pass over the open deliveries, without waiting. */
  tick(): Promise<void>
  /**
   * Called by the approval card after the user decides. `approve` carries the
   * token that `ApprovalHost.grant` returned in the card's button handler.
   */
  resolve(requestId: string, decision: { kind: 'approve'; token: ApprovalToken } | ApprovalDecision): Promise<void>
}

interface Pending {
  delivery: Delivery
  printerId: string
  data: Uint8Array
  request: ApprovalRequest
}

const RETRY_MS = 5000
const POLL_WAIT_S = 25

export function createDeliveryAgent(opts: DeliveryAgentOptions): DeliveryAgent {
  const { client, deviceId } = opts
  const mapId = opts.printerId ?? ((id: string) => id)
  const now = opts.now ?? (() => new Date())
  const pending = new Map<string, Pending>()
  const busy = new Set<string>()
  let controller: AbortController | null = null
  let stopped = false

  const emit = (e: DeliveryEvent) => opts.onEvent?.(e)

  async function report(d: Delivery, state: Parameters<CloudClient['setDeliveryState']>[2], message?: string) {
    const res = await client.setDeliveryState(deviceId, d.id, state, message)
    return res.ok ? res.value : null
  }

  async function failDelivery(d: Delivery, message: string) {
    await report(d, 'failed', message)
    emit({ type: 'failed', delivery: d, message })
  }

  async function prepare(d: Delivery) {
    const local = d.printerLocalId === null ? null : mapId(d.printerLocalId)
    if (local === null) {
      await failDelivery(d, 'this bridge no longer has that printer')
      return
    }
    if (d.state === 'approved' || d.state === 'uploaded') {
      // The approval token lived only in memory; ask again rather than print without one.
      await failDelivery(d, 'the bridge restarted before the print started; send the job again')
      return
    }
    const got = await client.downloadDelivery(d)
    if (!got.ok) {
      if (!isRetryable(got.code)) await failDelivery(d, got.message)
      return
    }
    let current = d
    if (d.state === 'offered') {
      const moved = await report(d, 'downloaded')
      if (!moved) return
      current = moved
    }
    const fileName = d.fileName
    const expiresAt = new Date(now().getTime() + (opts.approvalTtlMs ?? 30 * 60_000)).toISOString()
    const request: ApprovalRequest = {
      id: globalThis.crypto.randomUUID(),
      sessionId: opts.sessionId ?? `cloud-delivery:${deviceId}`,
      tool: 'cloud.deliver',
      permission: 'start',
      title: `Print ${fileName} on this printer?`,
      lines: [
        'Sliced in the cloud and sent to this printer',
        `${Math.round(d.stats.timeS / 60)} min, ${d.stats.filamentG.toFixed(1)} g`,
        `SHA-256 ${d.sha256.slice(0, 12)}`,
      ],
      printerId: local,
      paramsHash: await hashParams({ deliveryId: d.id, printerId: local, sha256: d.sha256 }),
      actions: [
        {
          action: 'printer.upload',
          target: local,
          paramsHash: await hashParams({ printerId: local, name: fileName, sha256: d.sha256 }),
        },
        {
          action: 'printer.start',
          target: local,
          paramsHash: await hashParams({ printerId: local, name: fileName, opts: {}, sha256: d.sha256 }),
        },
      ],
      expiresAt,
    }
    await opts.approvals.register(request)
    if (current.state !== 'awaiting_approval') {
      const moved = await report(current, 'awaiting_approval')
      if (!moved) return
      current = moved
    }
    pending.set(request.id, { delivery: current, printerId: local, data: got.value, request })
    emit({ type: 'approval_needed', delivery: current, request })
  }

  async function tick(signal?: AbortSignal, waitS = 0) {
    const res = await client.deliveries(deviceId, waitS, signal)
    if (!res.ok) {
      emit({ type: 'poll_error', message: res.message })
      return false
    }
    const known = new Set([...pending.values()].map((p) => p.delivery.id))
    for (const d of res.value) {
      if (known.has(d.id) || busy.has(d.id)) continue
      busy.add(d.id)
      try {
        await prepare(d)
      } finally {
        busy.delete(d.id)
      }
    }
    return true
  }

  return {
    async run() {
      stopped = false
      while (!stopped) {
        controller = new AbortController()
        const okPoll = await tick(controller.signal, POLL_WAIT_S)
        if (!okPoll && !stopped) await new Promise((r) => setTimeout(r, RETRY_MS))
      }
    },

    stop() {
      stopped = true
      controller?.abort()
    },

    async tick() {
      await tick()
    },

    async resolve(requestId, decision) {
      const p = pending.get(requestId)
      // An approval without the minted token cannot print; the card must pass it.
      if (!p || (decision.kind === 'approve' && !('token' in decision))) return
      pending.delete(requestId)
      if (decision.kind === 'deny') {
        await opts.approvals.deny(requestId, decision.reason)
        await report(p.delivery, 'declined', decision.reason)
        emit({ type: 'declined', delivery: p.delivery })
        return
      }
      if (!('token' in decision)) return
      const { token } = decision
      if (!(await report(p.delivery, 'approved'))) return
      try {
        const remote = await opts.printers.upload(
          p.printerId,
          {
            name: p.delivery.fileName,
            kind: 'gcode',
            data: p.data.slice().buffer,
            sha256: p.delivery.sha256,
          },
          token,
        )
        await report(p.delivery, 'uploaded')
        await opts.printers.start({ ...remote, sha256: remote.sha256 ?? p.delivery.sha256 }, {}, token)
        const printing = await report(p.delivery, 'printing')
        emit({ type: 'printing', delivery: printing ?? p.delivery })
      } catch (e) {
        await failDelivery(p.delivery, e instanceof Error ? e.message.slice(0, 500) : 'the printer refused the job')
      }
    },
  }
}
