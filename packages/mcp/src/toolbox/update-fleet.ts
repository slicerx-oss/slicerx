// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'
import { fleetId, editHints, fleetEdit } from './fleet'

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'update_fleet',
    title: 'Change a fleet color or icon',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'fleets',
    ungated: true,
    description: 'Set or clear (null) the color and icon of a fleet.',
    input: z.object({ fleet_id: fleetId, color: z.string().max(32).nullable().optional(), icon: z.string().max(40).nullable().optional() }),
    hints: editHints,
    run: (args) => fleetEdit(d, 'fleet.update', args, () => printers.host.updateFleet(args.fleet_id, { ...(args.color !== undefined ? { color: args.color } : {}), ...(args.icon !== undefined ? { icon: args.icon } : {}) })),
  })
}
