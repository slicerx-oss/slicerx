// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The worker starts on the small core engine and loads the full one (the modeling tools and the heavier modules)
// only when a call needs it: an operation the core lacks, or a mesh with face ids, which the core would drop.
// Once loaded, the full engine takes every call, so faces never go back through the core.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { geomCalls, noteLoadError } from '../src/geom/client'
import { engineModules, type EngineModule, type LoadError } from '../src/geom/modules'
import { get as getState } from '../src/state/store'

function fake(name: string, ops: string[], log: string[]): () => Promise<EngineModule> {
  return async () => {
    log.push(`load ${name}`)
    return { operations: new Set(ops), call: (op) => `${name}:${op}` }
  }
}

describe('the geometry engine modules', () => {
  it('runs core operations on the core and loads the full engine only when a call needs it', async () => {
    const log: string[] = []
    const m = engineModules(fake('core', ['boolean', 'repair'], log), fake('full', ['boolean', 'repair', 'edge.fillet'], log))
    expect(await m.run('repair', { mesh: { positions: [], indices: [] } })).toBe('core:repair')
    expect(log).toEqual(['load core'])
    expect(await m.run('edge.fillet', {})).toBe('full:edge.fillet')
    expect(await m.run('repair', {})).toBe('full:repair')
    expect(log).toEqual(['load core', 'load full'])
  })

  it('sends a mesh with face ids to the full engine', async () => {
    const log: string[] = []
    const m = engineModules(fake('core', ['boolean'], log), fake('full', ['boolean'], log))
    const a = { mesh: { positions: [], indices: [], faces: { ids: [0], table: [] } } }
    expect(await m.run('boolean', { a: [a], b: [] })).toBe('full:boolean')
  })

  it('starts on the full engine when there is no core build', async () => {
    const log: string[] = []
    const missing = async (): Promise<EngineModule> => {
      throw new Error('not found')
    }
    const m = engineModules(missing, fake('full', ['repair'], log))
    expect(await m.run('repair', {})).toBe('full:repair')
    expect(log).toEqual(['load full'])
  })

  it('answers from the core when the full engine is missing too', async () => {
    const m = engineModules(fake('core', ['repair'], []), async () => {
      throw new Error('not found')
    })
    await expect(m.run('edge.fillet', {})).rejects.toThrow(/not in this build/)
    expect(await m.run('repair', {})).toBe('core:repair')
  })

  it('reports a build that does not load, once, with its reason', async () => {
    const reports: LoadError[] = []
    const m = engineModules(
      async () => {
        throw new Error('sx_geom_core.wasm: 404')
      },
      async () => {
        throw new Error('sx_geom_wasm.wasm: 404')
      },
      (e) => reports.push(e),
    )
    await expect(m.run('repair', {})).rejects.toThrow(/did not start/)
    await expect(m.run('repair', {})).rejects.toThrow(/did not start/)
    expect(reports).toEqual([
      { module: 'core', message: 'sx_geom_core.wasm: 404' },
      { module: 'full', message: 'sx_geom_wasm.wasm: 404' },
    ])
  })
})

describe('a geometry engine that did not load', () => {
  afterEach(() => {
    localStorage.removeItem('slicerx.debug')
    vi.restoreAllMocks()
  })

  it('is kept for the bridge, logged once, and shown as a notice in debug mode only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(geomCalls().loadError).toBeNull()
    noteLoadError({ module: 'full', message: 'sx_geom_wasm.wasm: 404' })
    expect(geomCalls().loadError).toEqual({ module: 'full', message: 'sx_geom_wasm.wasm: 404' })
    // A worker that starts again and fails the same way is not logged again.
    noteLoadError({ module: 'full', message: 'sx_geom_wasm.wasm: 404' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toMatch(/full build did not load: sx_geom_wasm\.wasm: 404/)
    await new Promise((r) => setTimeout(r, 0))
    expect(getState().toast).toBeNull()

    localStorage.setItem('slicerx.debug', '1')
    noteLoadError({ module: 'core', message: 'CompileError: invalid magic' })
    expect(geomCalls().loadError).toEqual({ module: 'core', message: 'CompileError: invalid magic' })
    await vi.waitFor(() => expect(getState().toast?.text).toBe('The geometry engine did not load (core: CompileError: invalid magic).'))
    expect(getState().toast?.tone).toBe('warn')
  })
})
