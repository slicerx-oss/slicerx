// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'
import { fleetId, printerIdArg, editHints, fleetEdit } from './fleet'

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'add_to_fleet',
    title: 'Add a printer to a fleet',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'fleets',
    ungated: true,
    description: 'Add a printer to a fleet. Adding one that is already there does nothing.',
    input: z.object({ fleet_id: fleetId, printer_id: printerIdArg }),
    hints: { ...editHints, idempotent: true },
    run: (args) => fleetEdit(d, 'fleet.add', args, () => printers.host.addToFleet(args.fleet_id, args.printer_id)),
  })
}
