// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'list_fleets',
    title: 'List fleets',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'fleets',
    ungated: true,
    description: 'List the fleets: optional groups of printers the user made, such as "Workshop", with their printer ids. Printers work without a fleet and can be in several.',
    input: z.object({}),
    async run() {
      return { summary: 'Fleets', structured: { fleets: await printers.host.fleets() } }
    },
  })
}
