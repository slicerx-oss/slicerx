// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer reached through an Obico tunnel, read only: whether the tunnel answers, this month's data and the running
// print's failure score. Connecting a printer through Obico is the person's to do in the app; no tool can.
import { TUNNEL_PROBLEM_TEXT, type TunnelReport } from '@slicerx/contracts'
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

/** "120 MB": whole megabytes, the unit the card shows. */
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

function summaryOf(r: TunnelReport): string {
  if (r.problem) return `${r.printerId} through Obico: ${TUNNEL_PROBLEM_TEXT[r.problem]}`
  const u = r.usage
  if (!u) return `${r.printerId} through Obico`
  return `${r.printerId} through Obico: ${mb(u.usedBytes)} used${u.leftBytes === null ? ', no monthly limit' : `, ${mb(u.leftBytes)} left this month`}`
}

const NO_TUNNEL = { reason: 'no_tunnel' } as const

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'printer.tunnel',
    title: 'Printer tunnel',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'printers',
    ungated: true,
    description:
      'Read how a printer reached through an Obico tunnel is doing: tunnel and host (never its user name or password); connected, whether the last status reading came through; problem (no_access, access_removed, data_limit, file_over_data_limit, not_connected or timed_out) with message in plain words; usage, this month\'s tunnel data in bytes (usedBytes, capBytes, leftBytes, unlimited, resetInSeconds); and prediction, Obico\'s failure score for the running print from 0 (looks fine) to 1 (looks failed), null when nothing prints. The camera is off through a tunnel, so slicerx_printer_snapshot refuses with not_supported and reason camera_off_tunnel. A printer on the local network is refused with not_supported and reason no_tunnel. Connecting a printer through Obico is done by the person in the app.',
    input: z.object({ printerId: z.string().min(1).describe('Id from slicerx_printer_list, such as "bay-1"') }),
    hints: { idempotent: true, openWorld: true },
    async run(args) {
      const read = printers.host.tunnel
      if (!read) throw new ToolInputError(`${args.printerId} is not reached through a tunnel; these printers are on the local network.`, 'not_supported', NO_TUNNEL)
      let r: TunnelReport
      try {
        r = await read.call(printers.host, args.printerId)
      } catch (e) {
        const err = e as { code?: unknown; message?: unknown; details?: { reason?: unknown } }
        if (err?.code === 'not_supported' && err.details?.reason === 'no_tunnel') throw new ToolInputError(`${args.printerId} is on the local network, not reached through a tunnel.`, 'not_supported', NO_TUNNEL)
        if (err?.code === 'not_found') throw new ToolInputError(`No printer ${args.printerId}.`, 'not_found')
        throw e
      }
      d.gate.log.append({ tool: 'printer.tunnel', permission: 'read', decision: 'read', input_hash: args.printerId, ok: true })
      return {
        summary: summaryOf(r),
        structured: {
          printerId: r.printerId,
          tunnel: r.tunnel,
          host: r.host,
          connected: r.connected,
          problem: r.problem,
          message: r.problem ? TUNNEL_PROBLEM_TEXT[r.problem] : null,
          usage: r.usage,
          prediction: r.prediction,
          camera: { available: false, reason: 'camera_off_tunnel' },
        },
      }
    },
  })
}
