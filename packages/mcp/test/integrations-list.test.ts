// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_integrations_list answers with what pluginLoads, the helper Settings > mimir reads, makes of the same
// plugins and printers: each integration's state (connected or off) and its bays.
import { pluginLoads } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import integrationsList from '../src/toolbox/integrations-list'
import type { ServerToolDeps } from '../src/toolbox/deps'
import { connect, data } from './helpers'

type Answer = { source: string; integrations: { id: string; name: string; state: string; bays: string[] }[] }

const MANIFESTS = [
  { id: 'bambu', name: 'Bambu Lab', kind: 'printer', tools: [{}, {}] },
  { id: 'moonraker', name: 'Klipper', kind: 'printer', tools: [{}] },
  { id: 'spoolman', name: 'Spoolman', kind: 'service', tools: [{}] },
]
const PRINTERS = [
  { id: 'a1', name: 'A1 mini', plugin: 'bambu' },
  { id: 'p1', name: 'Bay 2', plugin: 'bambu' },
]

describe('slicerx_integrations_list', () => {
  it('names each integration with its state and bays, as the Settings helper reads them', async () => {
    const host = { plugins: async () => MANIFESTS, list: async () => PRINTERS }
    const tool = integrationsList({ printers: { kind: 'link', host } } as unknown as ServerToolDeps)!
    const out = (await tool.run({} as never, {} as never)) as { summary: string; structured: Answer }
    expect(out.structured.integrations).toEqual([
      { id: 'bambu', name: 'Bambu Lab', state: 'connected', bays: ['A1 mini', 'Bay 2'] },
      { id: 'moonraker', name: 'Klipper', state: 'off', bays: [] },
      { id: 'spoolman', name: 'Spoolman', state: 'connected', bays: [] },
    ])
    // the same states and printers the helper gives Settings
    const loads = pluginLoads(MANIFESTS as never, PRINTERS)
    expect(out.structured.integrations.map((i) => [i.id, i.state === 'connected' ? 'ready' : i.state, i.bays])).toEqual(loads.map((l) => [l.id, l.state, l.bays]))
    expect(out.summary).toBe('3 integrations, 2 connected')
  })

  it('is listed over MCP and reads the demo printers', async () => {
    const h = await connect({ printers: 'demo' })
    const r = data<Answer>(await h.call('slicerx_integrations_list'))
    const host = h.ctx.printers!.host
    const loads = pluginLoads(await host.plugins(), await host.list())
    expect(r.source).toBe('demo')
    expect(r.integrations.map((i) => i.id)).toEqual(loads.map((l) => l.id))
    expect(r.integrations.map((i) => i.bays)).toEqual(loads.map((l) => l.bays))
  })

  it('is not offered without printers', async () => {
    expect(integrationsList({ printers: undefined } as unknown as ServerToolDeps)).toBeNull()
  })
})
