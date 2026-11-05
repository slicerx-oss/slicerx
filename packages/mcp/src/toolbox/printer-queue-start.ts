// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Asks a person to start a plate already in the hub's queue, now. The hub raises the plate's card (or returns the one
// waiting) and starts the plate itself once a person approves it in the app, at the printer, or on a paired phone
// under the remote start rule. The client never gets a token and cannot answer the card.
import { productName, type ApprovalRequest } from '@slicerx/contracts'
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

/** A queued plate as the hub shows it to an agent: no file hash, options, card or approval. */
interface QueuedPlate {
  id: string
  printerId: string
  name: string
  state: string
  startAfter?: string
}

interface QueueHub {
  queue: { list(): Promise<QueuedPlate[]>; start(itemId: string): Promise<{ item: QueuedPlate; request?: ApprovalRequest }> }
}

function queueOf(host: unknown): QueueHub | undefined {
  const h = host as Partial<QueueHub> | undefined
  return typeof h?.queue?.start === 'function' && typeof h.queue.list === 'function' ? (h as QueueHub) : undefined
}

const OPEN = new Set(['waiting', 'awaiting_approval', 'approved', 'needs_bed'])

/** A queued plate as a client reads it, from the hub's redacted view. */
const row = (i: QueuedPlate) => ({ itemId: i.id, printerId: i.printerId, name: i.name, state: i.state, scheduled: Boolean(i.startAfter), startAfter: i.startAfter ?? null })

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'printer.queue_start',
    title: 'Start a queued plate',
    version: '1.0.0',
    source: 'command',
    permission: 'queue',
    // Listing is a read; asking for a card is a write the user's policy decides.
    permissionFor: (i: { itemId?: string | undefined }) => (i.itemId ? 'queue' : 'read'),
    toolset: 'printers',
    description: `Ask a person to start a plate that is already in the ${productName()} hub's queue, now. With itemId, the hub raises that plate's approval card (or returns the one already waiting) and starts the plate itself once a person approves it in ${productName()}, at the printer, or on a paired phone away from home when the printer has remote start on and a fresh plate check passed (see slicerx_remote_start_policy). This tool never starts a print and cannot approve the card; check slicerx_pending_approvals or the queue state for the outcome. Returns output with the item (itemId, printerId, name, state, scheduled, startAfter) and request_id of the card, which says who asked; a person declining it leaves the plate in the queue. Without itemId it lists the open queued plates to choose from (output.queued), as the hub shows them to clients (no file hash, options or card); a partner app sees only plates it queued. Refusals: busy while a print is on the printer's plate, invalid_input with reason bad_state for a scheduled plate (it starts at its time) or one that left the queue, not_found for an unknown itemId. Simulated printers have no queue and are refused with not_supported and reason no_hub.`,
    input: z.object({ itemId: z.string().min(1).max(64).optional().describe('Queue item id, such as "q-1a2b3c4d5e6f". Leave out to list the open queued plates.') }),
    hints: { readOnly: false, idempotent: true, openWorld: true },
    async run(args) {
      const hub = printers.kind === 'link' ? queueOf(printers.host) : undefined
      if (!hub) throw new ToolInputError(`These printers have no queue. It runs beside the ${productName()} app, through its hub.`, 'not_supported', { reason: 'no_hub' })
      if (!args.itemId) {
        const open = (await hub.queue.list.call(hub.queue)).filter((i) => OPEN.has(i.state)).map(row)
        d.gate.log.append({ tool: 'printer.queue_start', permission: 'read', decision: 'read', input_hash: '*', ok: true })
        return { summary: open.length ? `${open.length} queued plate${open.length === 1 ? '' : 's'}; pick one by itemId` : 'Nothing is queued.', output: { queued: open } }
      }
      let out: { item: QueuedPlate; request?: ApprovalRequest }
      try {
        out = await hub.queue.start.call(hub.queue, args.itemId)
      } catch (e) {
        const err = e as { code?: unknown; message?: unknown }
        const message = String(err?.message ?? err?.code)
        if (err?.code === 'not_found' || err?.code === 'busy') throw new ToolInputError(message, err.code)
        if (err?.code === 'bad_state') throw new ToolInputError(message, 'invalid_input', { reason: 'bad_state' })
        throw e
      }
      d.gate.log.append({ tool: 'printer.queue_start', permission: 'queue', decision: 'needs_person', input_hash: args.itemId, ok: true })
      const waiting = out.item.state === 'awaiting_approval'
      return {
        summary: waiting ? `Waiting for a person to approve ${out.item.name} on the card` : `${out.item.name}: ${out.item.state}`,
        output: { item: row(out.item), request_id: out.request?.id ?? null, status: waiting ? 'waiting_for_person' : out.item.state },
      }
    },
  })
}
