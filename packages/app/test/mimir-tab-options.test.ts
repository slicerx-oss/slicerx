// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab builds its runtime from @slicerx/pilot's tab options, the code the creative eval also runs with: the
// same tools, the edition's tool groups, the cad scope where the host does not slice, and the tab's step and tool call
// limits.
import type { Host, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, DEFAULT_CONFIG, defineTool, tabOptions, TAB_MIN_STEPS, TAB_MIN_TOOL_CALLS, type PilotTool } from '@slicerx/pilot'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NEUTRAL } from '../src/edition'
import { editionToolGroups } from '../src/pilot-connect/brain'
import { setHostSlices } from '../src/state/model-mode'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { mimirCommands, tabPilotOptions } from '../src/workspaces/mimir/session'

afterEach(() => setHostSlices(true))

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }
const host = { kind: 'web', slicer: {}, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
const tool = (name: string) => defineTool({ name, version: '1.0.0', source: 'command', permission: 'read', description: name, input: z.object({}), run: async () => ({ summary: 'ok' }) }) as PilotTool<never>
const TOOLS = [tool('design.new'), tool('geom.info')]
const off = { ...NEUTRAL, ai: { ...NEUTRAL.ai, brain: { ...NEUTRAL.ai.brain, tools: { printers: false } } } }

describe('the mimir tab uses the shared tab options', () => {
  for (const slices of [true, false]) {
    it(`matches tabOptions ${slices ? 'where the host slices' : 'in the browser build'}`, async () => {
      setHostSlices(slices)
      const kb = await bundledKb()
      const config = { ...DEFAULT_CONFIG, maxSteps: 24, maxToolCalls: 40 }
      const groups = editionToolGroups(off)
      const app = tabPilotOptions(host, { llm: noLlm, config, kb, tools: TOOLS, commands: [], toolGroups: groups })
      const shared = tabOptions({ slices, config, kb, tools: TOOLS, commands: mimirCommands(host, []), toolGroups: groups })
      expect(app.config).toEqual(shared.config)
      expect(app.config).toMatchObject({ maxSteps: TAB_MIN_STEPS, maxToolCalls: TAB_MIN_TOOL_CALLS })
      expect(app.scope).toBe(shared.scope)
      expect(app.scope).toBe(slices ? undefined : 'cad')
      expect(app.surface).toBe(shared.surface)
      expect(app.policy).toBe(shared.policy)
      expect(app.toolGroups).toEqual({ printers: false })
      expect(app.tools?.map((t) => t.name)).toEqual(shared.tools?.map((t) => t.name))
      const names = (o: Parameters<typeof createPilot>[0]) => createPilot(o).tools().map((t) => t.name).sort()
      expect(names(app)).toEqual(names({ ...app, ...shared }))
    })
  }
})
