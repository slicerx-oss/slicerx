// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'
import { printerIdArg, editHints, fleetEdit } from './fleet'

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'create_fleet',
    title: 'Create a fleet',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'fleets',
    ungated: true,
    description: 'Create a named group of printers. Names are unique ignoring case. Only organizes printers; nothing is sent to them.',
    input: z.object({
      name: z.string().min(1).max(60),
      printer_ids: z.array(printerIdArg).max(200).optional(),
      color: z.string().max(32).optional().describe('Palette name such as "purple" or a hex color'),
      icon: z.string().max(40).optional().describe('Icon name such as "printer"'),
    }),
    hints: editHints,
    run: (args) => fleetEdit(d, 'fleet.create', args, () => printers.host.createFleet(args.name, { ...(args.printer_ids ? { printerIds: args.printer_ids } : {}), ...(args.color ? { color: args.color } : {}), ...(args.icon ? { icon: args.icon } : {}) })),
  })
}
