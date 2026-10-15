// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir.dock over the app link, as a client reads it: what answers in the docked chat, and the tools its model is
// offered there. A local model gets the dock's shorter list, and the read-back reports that list, not the registry.
import { afterEach, describe, expect, it } from 'vitest'
import type { Host, PilotConfig, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, DEFAULT_CONFIG } from '@slicerx/pilot'
import { runCall } from '../src/app-link/methods'
import { setDockPilot } from '../src/features/pilot/dock-model'
import { bundledKb } from '../src/features/pilot/kb'
import { dockPilotOptions } from '../src/features/pilot/use-pilot'

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('not in this test') } }
const host = { kind: 'web', slicer: {}, printers, capabilities: { threads: 1 } } as unknown as Host

async function dock(config: PilotConfig) {
  const options = dockPilotOptions(host, { printers, llm: noLlm, approvals: createApprovalBroker(), config, kb: await bundledKb() })
  return createPilot(options)
}

type DockAnswer = { link: string; provider: string | null; model: string | null; local: boolean; tools: string[] }

describe('mimir.dock', () => {
  afterEach(() => setDockPilot(null))

  it('answers none before the docked chat is set up', async () => {
    expect(await runCall('mimir.dock', {})).toEqual({ link: 'none', provider: null, model: null, local: false, tools: [] })
  })

  it('lists the shorter tool list a local model is offered, and the whole list for a cloud model', async () => {
    const localConfig: PilotConfig = { ...DEFAULT_CONFIG, provider: 'openai-compatible', model: 'qwen3:8b-16k' }
    const local = await dock(localConfig)
    setDockPilot({ pilot: local, link: 'model', config: localConfig })
    const l = (await runCall('mimir.dock', {})) as DockAnswer
    expect(l).toMatchObject({ link: 'model', provider: 'openai-compatible', model: 'qwen3:8b-16k', local: true })
    expect(l.tools).toContain('text_to_part')
    expect(l.tools).not.toContain('make_model')
    // the registry still has it; the read-back reports what the model sees
    expect(local.registry().map((t) => t.name)).toContain('make_model')

    const cloudConfig: PilotConfig = { ...DEFAULT_CONFIG, provider: 'anthropic', model: 'claude-haiku-5-5' }
    const cloud = await dock(cloudConfig)
    setDockPilot({ pilot: cloud, link: 'model', config: cloudConfig })
    const c = (await runCall('mimir.dock', {})) as DockAnswer
    expect(c).toMatchObject({ link: 'model', provider: 'anthropic', local: false })
    expect(c.tools).toContain('make_model')
    expect(c.tools.filter((n) => n !== 'make_model')).toEqual(l.tools)
    expect(JSON.stringify(c)).not.toMatch(/key|token/i)
  })

  it('says the demo answers, with no model named', async () => {
    const pilot = await dock(DEFAULT_CONFIG)
    setDockPilot({ pilot, link: 'demo', config: DEFAULT_CONFIG })
    expect(await runCall('mimir.dock', {})).toMatchObject({ link: 'demo', provider: null, model: null, local: false })
  })
})
