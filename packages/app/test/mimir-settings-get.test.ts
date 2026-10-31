// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir reads the print settings the shown plate slices with (settings.get), the same read as the app link's
// settings.get: on an untouched project the layer height is the active value, from the Easy choices or the printer's
// preset, not one the model knows by heart.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Host, PilotEvent, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, turnSetsOf } from '@slicerx/pilot'
import { setProfileLayer } from '../src/adapters/config'
import { activeMeta } from '../src/plate/plates'
import { profileReady } from '../src/state/profile-sync'
import { plateSliceConfig } from '../src/state/slice-plate'
import { get, set } from '../src/state/store'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { tabPilotOptions } from '../src/workspaces/mimir/session'

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }

/** The tab's runtime asked "What layer height is set?", its model calling settings.get with `args`: the tool's result. */
async function ask(args: Record<string, unknown>) {
  const host = { kind: 'web', slicer: { loadParts: async () => { throw new Error('no parts') } }, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
  const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: [] })
  const pilot = createPilot({ ...options, client: createScriptedClient([{ calls: [{ name: 'settings.get', args }] }, { text: 'Done.' }], { chunk: false }) })
  const events: PilotEvent[] = []
  for await (const ev of pilot.run('tab', 'What layer height is set?', {})) events.push(ev)
  const result = events.find((e) => e.type === 'tool_result')
  return { pilot, result: result as Extract<PilotEvent, { type: 'tool_result' }> | undefined }
}

const active = (key: string) => plateSliceConfig(get(), activeMeta(get()))[key]

describe('mimir reads the active settings', () => {
  beforeEach(async () => {
    set((s) => ({ plate: [], plates: s.plates.map((p) => ({ ...p, objects: [] })), overrides: {}, printerModel: null, goal: 'standard' }))
    await profileReady()
  })
  afterEach(() => setProfileLayer(null, []))

  it('reads the layer height on an untouched project', async () => {
    const { pilot, result } = await ask({ keys: ['layer_height'] })
    expect(pilot.tools().map((t) => t.name)).toContain('settings.get')
    expect(result).toMatchObject({ ok: true })
    const out = result!.output as { overrides: Record<string, unknown>; effective: Record<string, unknown>; shadowed: string[] }
    expect(out.overrides).toEqual({})
    expect(out.effective).toEqual({ layer_height: active('layer_height') })
    expect(out.shadowed).toEqual([])
    // only the asked key: not the lists of supported and read-only keys the full read carries
    expect(Object.keys(out).sort()).toEqual(['effective', 'overrides', 'plate', 'shadowed'])
  })

  it("reads the printer preset's value when a printer is picked, and the project's override over it", async () => {
    setProfileLayer({ layer_height: 0.16 }, [])
    set({ overrides: {} })
    expect((await ask({ keys: ['layer_height'] })).result!.output).toMatchObject({ overrides: {}, effective: { layer_height: 0.16 } })
    set({ overrides: { layer_height: 0.24 } })
    expect((await ask({ keys: ['layer_height'] })).result!.output).toMatchObject({ overrides: { layer_height: 0.24 }, effective: { layer_height: 0.24 } })
  })

  it('reads the settings people ask about most when no keys are given, and names the other overrides', async () => {
    set({ overrides: { ironing_type: 'top' } })
    const out = (await ask({})).result!.output as { effective: Record<string, unknown>; otherOverrides?: string[] }
    expect(out.effective).toMatchObject({ layer_height: active('layer_height'), wall_loops: active('wall_loops'), sparse_infill_density: active('sparse_infill_density') })
    expect(Object.keys(out.effective).length).toBeLessThanOrEqual(20)
    expect(out.otherOverrides).toEqual(['ironing_type'])
  })

  it('refuses a key that is not a print setting, as the app link does', async () => {
    const { result } = await ask({ keys: ['machine_start_gcode'] })
    expect(result).toMatchObject({ ok: false })
  })

  it('is in the app set of a local model', () => {
    expect(turnSetsOf({ name: 'settings.get' })).toEqual(new Set(['app']))
  })
})
