// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'printer.snapshot',
    title: 'Camera snapshot',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'printers',
    ungated: true,
    description: `Take a camera snapshot from a printer and return it as an image. A printer reached through Obico has its camera off and is refused with not_supported and reason camera_off_tunnel.${printers.kind === 'demo' ? ' Simulated printers return a placeholder image.' : ''}`,
    input: z.object({ printer_id: z.string().min(1) }),
    hints: { idempotent: false, openWorld: true },
    async run(args) {
      let blob: Blob | null
      try {
        blob = await printers.host.snapshot(args.printer_id)
      } catch (e) {
        // A printer reached through Obico: its camera is off there for now.
        const err = e as { code?: unknown; details?: { reason?: unknown } }
        if (err?.code === 'not_supported' && err.details?.reason === 'camera_off_tunnel') {
          throw new ToolInputError(`The camera of ${args.printer_id} is off while it is reached through Obico. slicerx_printer_tunnel reads its tunnel.`, 'not_supported', { reason: 'camera_off_tunnel' })
        }
        throw e
      }
      d.gate.log.append({ tool: 'printer.snapshot', permission: 'read', decision: 'read', input_hash: args.printer_id, ok: blob !== null })
      if (!blob) throw new ToolInputError(`${args.printer_id} has no camera or is offline.`)
      const data = Buffer.from(await blob.arrayBuffer()).toString('base64')
      return { summary: `Snapshot of ${args.printer_id}`, passthrough: { content: [{ type: 'image', data, mimeType: blob.type || 'image/jpeg' }] } }
    },
  })
}
