// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval (@slicerx/mcp evals/creative) offers mimir the tools the mimir tab offers: for the same edition and
// whether the host slices, the same tool names in the same order and groups, as the tab builds them here and as the
// eval builds them on its own design host. The app's commands are registered as at startup and given to the eval too,
// so the app.* tools are compared as well.
import type { Host, MeshHandle, MeshPart } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { creativeEnv, CREATIVE_TAB } from '@slicerx/mcp/evals/creative'
import { createScriptedClient, toolGroupOf } from '@slicerx/pilot'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { builtinCommands } from '../src/commands/builtin'
import { listCommands, registerCommands } from '../src/commands/registry'
import { setupCommands } from '../src/first-run/look'
import { setHostSlices } from '../src/state/model-mode'
import { get, set } from '../src/state/store'
import { resetTabMimir, tabMimir, tabState } from '../src/workspaces/mimir/session'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const host = { kind: 'desktop', capabilities: { secureStorage: true }, slicer: loader, build: { version: '0.0.0-test' } } as unknown as Host

const neutral = CREATIVE_TAB.edition as EditionConfig
const brain = neutral.ai.brain
const editions: [string, EditionConfig][] = [
  ['the neutral edition', neutral],
  ['an edition with printers and web off and no notes', { ...neutral, ai: { ...neutral.ai, brain: { ...brain, tools: { printers: false, web: false }, memory: { ...brain.memory, local: false } } } }],
]

const grouped = (tools: readonly Parameters<typeof toolGroupOf>[0][]): string[] => tools.map((t) => `${t.name} (${toolGroupOf(t)})`).sort()

describe('the creative eval offers the mimir tab its tools', () => {
  const was = { pilot: get().pilot }
  let off: () => void = () => undefined
  beforeAll(() => {
    // the commands the app registers at startup (app.tsx): the built-in ones over the default tabs, and the setup ones
    const workspaces = [
      { id: 'prepare', label: 'Slice' },
      { id: 'library', label: 'My models' },
      { id: 'printers', label: 'Printers' },
    ]
    off = registerCommands([...builtinCommands(host, workspaces), ...setupCommands()])
  })
  afterAll(() => off())
  beforeEach(() => resetTabMimir())
  afterEach(() => {
    resetTabMimir()
    setHostSlices(true)
    set(was)
  })

  for (const slices of [true, false]) {
    for (const [what, edition] of editions) {
      it(`${slices ? 'where the host slices' : 'in the browser build'}, in ${what}`, async () => {
        setHostSlices(slices)
        set({ pilot: { mode: 'unset' } })
        const pilot = await tabMimir(host, edition)
        const tab = tabState().tools
        const env = creativeEnv({ id: 'tools', title: 'Tools', prompt: 'x', machine: { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }, bodies: [1, 1] }, createScriptedClient([{ text: 'ok' }], { chunk: false }), {}, { slices, edition, commands: listCommands() })
        const offered = env.pilot.tools()
        expect(tab.some((n) => n.startsWith('app.'))).toBe(true)
        expect(offered.map((t) => t.name)).toEqual(tab)
        expect(tab).toContain('design.new')
        expect(tab).toContain('design.plan')
        expect(tab).not.toContain('text_to_part')
        expect(grouped(offered)).toEqual(grouped(pilot.tools()))
      })
    }
  }
})
