// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'
import { fleetId, editHints, fleetEdit } from './fleet'

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'delete_fleet',
    title: 'Delete a fleet',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'fleets',
    ungated: true,
    description: 'Delete a fleet. Its printers stay connected; only the group goes away.',
    input: z.object({ fleet_id: fleetId }),
    hints: { ...editHints, destructive: true },
    run: (args) => fleetEdit(d, 'fleet.delete', args, () => printers.host.deleteFleet(args.fleet_id).then(() => ({ deleted: args.fleet_id }))),
  })
}
