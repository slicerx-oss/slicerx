// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The worker starts on the small core engine and loads the full one (the modeling tools and the heavier modules)
// only when a call needs it: an operation the core lacks, or a mesh with face ids, which the core would drop.
// Once loaded, the full engine takes every call, so faces never go back through the core.
import { describe, expect, it } from 'vitest'
import { engineModules, type EngineModule } from '../src/geom/modules'

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
})
