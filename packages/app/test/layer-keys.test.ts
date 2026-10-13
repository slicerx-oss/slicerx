// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the layer actions add over the layer keys: one layer mode that follows a step, and the same actions as app
// tools a client calls by name and reads back with layerView.
import type { LookAndFeelChoice, PreviewBuffers } from '@slicerx/contracts'
import { keymapFor } from '@slicerx/ui'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandIdForTool, commandTools, registerCommands, runCommand } from '../src/commands/registry'
import { bindPlateKeys } from '../src/plate/keys'
import { get, set } from '../src/state/store'
import { layerCommands, layerView } from '../src/workspaces/preview/layer-keys'

const LAYERS = 20

function showToolpaths(): void {
  set({
    workspace: 'prepare',
    modelMode: 'slice',
    sliceLook: 'toolpaths',
    preview: { layerCount: LAYERS } as unknown as PreviewBuffers,
    layerHi: LAYERS,
    layerLo: 1,
    moveCut: 1,
    legendHidden: false,
    layerJump: false,
    objectTool: null,
    setup: null,
    commandOpen: false,
    settingsOpen: false,
    shortcutsOpen: false,
  })
}

afterEach(() => set({ preview: null, layerHi: 0, layerLo: 1, legendHidden: false, layerJump: false }))

const press = (key: string, shift = false) => {
  const code = /^[A-Z]$/i.test(key) ? `Key${key.toUpperCase()}` : key
  const e = new KeyboardEvent('keydown', { key, code, shiftKey: shift, bubbles: true, cancelable: true })
  window.dispatchEvent(e)
  return e
}

describe('the layer keys with the new actions', () => {
  let off: () => void = () => undefined
  const bind = (id: string) => {
    off = bindPlateKeys(() => ({ id }) as unknown as LookAndFeelChoice)
  }
  beforeEach(showToolpaths)
  afterEach(() => off())

  it('keeps one layer mode on while the arrows step, and Shift+L brings back every layer below', () => {
    bind('slicerx')
    press('L', true)
    expect(layerView()).toMatchObject({ oneLayer: true, layer: LAYERS, lowest: LAYERS })
    press('ArrowDown')
    press('ArrowDown')
    expect(layerView()).toMatchObject({ oneLayer: true, layer: LAYERS - 2, lowest: LAYERS - 2 })
    press('L', true)
    expect(layerView()).toMatchObject({ oneLayer: false, layer: LAYERS - 2, lowest: 1 })
  })

  it('reads the solid models as no toolpaths, with the layers still there to step', () => {
    set({ sliceLook: 'solid' })
    expect(layerView()).toMatchObject({ showing: true, toolpaths: false, layer: LAYERS, layerCount: LAYERS })
  })

  it('reads the jump to a layer field as open after Shift+G', () => {
    bind('slicerx')
    expect(press('G', true).defaultPrevented).toBe(true)
    expect(layerView()).toMatchObject({ jumpOpen: true, layer: LAYERS })
  })
})

describe('the layer actions as app tools', () => {
  let off: () => void = () => undefined
  beforeEach(() => {
    showToolpaths()
    const map = keymapFor('slicerx')
    off = registerCommands(layerCommands((a) => map[a] ?? undefined))
  })
  afterEach(() => off())

  /** Calls a tool by the name a client sees. */
  const call = async (tool: string, input?: unknown) => {
    const id = commandIdForTool(tool)
    expect(id, tool).toBeDefined()
    return runCommand(id!, input)
  }

  it('lists the four actions', () => {
    const names = commandTools().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['app.layer_up', 'app.layer_down', 'app.layer_one', 'app.layer_legend']))
  })

  it('changes the layer, one layer mode and the legend, and reads each back', async () => {
    expect(await call('app.layer_down')).toEqual({ ok: true })
    expect(layerView()).toMatchObject({ showing: true, layer: LAYERS - 1, layerCount: LAYERS, jumpOpen: false })
    await call('app.layer_one')
    expect(layerView()).toMatchObject({ oneLayer: true, lowest: LAYERS - 1 })
    await call('app.layer_down')
    expect(layerView()).toMatchObject({ oneLayer: true, layer: LAYERS - 2, lowest: LAYERS - 2 })
    await call('app.layer_up')
    expect(layerView()).toMatchObject({ oneLayer: true, layer: LAYERS - 1, lowest: LAYERS - 1 })
    await call('app.layer_legend')
    expect(layerView().legend).toBe(false)
    // the top is as far as a step goes
    await call('app.layer_up')
    await call('app.layer_up')
    expect(layerView()).toMatchObject({ layer: LAYERS, lowest: LAYERS })
  })

  it('shows the toolpaths when a step starts on the solid models', async () => {
    set({ sliceLook: 'solid' })
    await call('app.layer_down')
    expect(get().sliceLook).toBe('toolpaths')
    expect(layerView()).toMatchObject({ toolpaths: true, layer: LAYERS - 1 })
  })

  it('refuses with no slice to step, and changes nothing', async () => {
    set({ modelMode: 'design' })
    expect((await call('app.layer_down')).ok).toBe(false)
    set({ modelMode: 'slice', preview: null })
    expect((await call('app.layer_up')).ok).toBe(false)
    expect(layerView()).toMatchObject({ showing: false, layer: 0, layerCount: 0 })
    expect(get().layerHi).toBe(LAYERS)
  })
})
