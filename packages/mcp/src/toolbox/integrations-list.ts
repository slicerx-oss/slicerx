// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The integrations list Settings > mimir shows, read the same way (pluginLoads), for a client.
import { pluginLoads } from '@slicerx/contracts'
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'integrations.list',
    title: 'List integrations',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'printers',
    ungated: true,
    description:
      'List the integrations mimir can use, as Settings > mimir shows them: each one with its state (connected or off) and the printers (bays) assigned to it. A printer integration with no printers assigned is off.',
    input: z.object({}),
    hints: { idempotent: true, openWorld: true },
    async run() {
      const [manifests, list] = await Promise.all([printers.host.plugins(), printers.host.list()])
      const integrations = pluginLoads(manifests, list).map((l) => ({ id: l.id, name: l.name, state: l.state === 'ready' ? 'connected' : l.state, bays: l.bays ?? [] }))
      const on = integrations.filter((i) => i.state === 'connected').length
      return { summary: `${integrations.length} integration${integrations.length === 1 ? '' : 's'}, ${on} connected`, structured: { source: printers.kind, integrations } }
    },
  })
}
