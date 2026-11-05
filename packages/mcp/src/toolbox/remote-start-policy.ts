// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Remote start, read only: whether an approver phone away from home may start a print on each printer after a fresh
// camera plate check, the temperature limits for it, and the printer's last plate check (no picture). Turning it on
// or changing the limits is the person's, in the app's printer settings; the hub refuses that from an agent.
import { productName } from '@slicerx/contracts'
import type { RemoteStartState } from '@slicerx/link-client'
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

interface RemoteStartRead {
  remoteStart: { get(printerId?: string): Promise<RemoteStartState> }
}

function readerOf(host: unknown): RemoteStartRead | undefined {
  const h = host as Partial<RemoteStartRead> | undefined
  return typeof h?.remoteStart?.get === 'function' ? (h as RemoteStartRead) : undefined
}

const NO_HUB = { reason: 'no_hub' } as const

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'remote_start.policy',
    title: 'Remote start policy',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'printers',
    ungated: true,
    description: `Read whether a paired phone away from home may approve starting a print on each printer (or one, with printerId), as the ${productName()} hub holds it. A start from afar needs all of this: enabled, the person turned remote start on for that printer (off by default); guard, the camera guard watches it; a plate check that compared the plate with the person's empty-plate picture, found it clear and is at most plateWindowSeconds old (plateCheck: checkedAt, clear, compared, passes, and reason when it does not pass: plate_missing, plate_stale, plate_failed or plate_not_compared); a file that heats the nozzle no higher than maxNozzleC and the bed no higher than maxBedC (°C), whose nozzle temperature the hub can read, and that heats no chamber (chamber is always never); and the person's own tick that the plate is clear on the phone. Pausing, stopping and skipping one object need none of it. Turning remote start on or off and changing the limits is done by the person in the app; no tool can. Simulated printers have no hub and are refused with not_supported and reason no_hub.`,
    input: z.object({ printerId: z.string().min(1).optional().describe('Id from slicerx_printer_list, such as "bay-1". Leave out for every printer.') }),
    hints: { idempotent: true, openWorld: true },
    async run(args) {
      const reader = printers.kind === 'link' ? readerOf(printers.host) : undefined
      if (!reader) throw new ToolInputError(`These printers have no remote start. It runs beside the ${productName()} app, through its hub.`, 'not_supported', NO_HUB)
      let state: RemoteStartState
      try {
        state = await reader.remoteStart.get.call(reader.remoteStart, args.printerId)
      } catch (e) {
        if ((e as { code?: unknown })?.code === 'not_found') throw new ToolInputError(`No printer ${args.printerId}.`, 'not_found')
        throw e
      }
      d.gate.log.append({ tool: 'remote_start.policy', permission: 'read', decision: 'read', input_hash: args.printerId ?? '*', ok: true })
      const on = state.printers.filter((p) => p.enabled).map((p) => p.printerId)
      const summary = args.printerId
        ? `${args.printerId}: remote start ${state.printers[0]?.enabled ? 'on' : 'off'}`
        : `Remote start ${on.length ? `on for ${on.join(', ')}` : 'off for every printer'}`
      return { summary, structured: { printers: state.printers, plateWindowSeconds: state.plateWindowSeconds, chamber: state.chamber } }
    },
  })
}
