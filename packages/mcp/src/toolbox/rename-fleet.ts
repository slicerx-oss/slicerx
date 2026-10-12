// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'
import { fleetId, editHints, fleetEdit } from './fleet'

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'rename_fleet',
    title: 'Rename a fleet',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'fleets',
    ungated: true,
    description: 'Rename a fleet. Names are unique ignoring case; the printers in it are unchanged.',
    input: z.object({ fleet_id: fleetId, name: z.string().min(1).max(60) }),
    hints: editHints,
    run: (args) => fleetEdit(d, 'fleet.rename', args, () => printers.host.renameFleet(args.fleet_id, args.name)),
  })
}
