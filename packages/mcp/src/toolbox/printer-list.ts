// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A read-only stand-in used only when mimir's registry has no printer.list of its own.
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'printer.list',
    title: 'List printers',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'printers',
    ungated: true,
    description: 'List every printer this server can reach, with vendor, model and connection plugin.',
    input: z.object({}),
    hints: { idempotent: false, openWorld: true },
    async run() {
      return { summary: 'Printers', structured: { source: printers.kind, ...(printers.kind === 'demo' ? { note: "These are simulated demo printers, not the user's own." } : {}), printers: await printers.host.list() } }
    },
  })
}
