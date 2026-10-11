// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataStore, resolveDataPaths, type DataPaths } from '../src/data'

function knowledgeDir(): DataPaths {
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-kb-'))
  writeFileSync(join(dir, 'pla.yaml'), 'kind: filament\nid: pla\nname: PLA\nnozzle_temp: [200, 220]\n')
  return { root: dir, layout: 'repo', knowledgeDir: dir, demoFleetFile: join(dir, 'none.json'), samplesDir: dir }
}

describe('knowledge parsed once per process', () => {
  it('gives each store the same entries as its own parse would, in objects of its own', () => {
    const paths = resolveDataPaths()
    const a = new DataStore(paths).knowledge()
    const b = new DataStore(paths).knowledge()
    expect(b).toEqual(a)
    expect(b.length).toBeGreaterThan(10)
    expect(b[0]?.data).not.toBe(a[0]?.data)
  })

  it('keeps one store\'s change to an entry out of the next store', () => {
    const paths = knowledgeDir()
    const first = new DataStore(paths).knowledge()[0]!
    ;(first.data['nozzle_temp'] as number[]).push(999)
    first.data['name'] = 'changed'
    expect(new DataStore(paths).knowledge()[0]?.data).toEqual({ kind: 'filament', id: 'pla', name: 'PLA', nozzle_temp: [200, 220] })
  })

  it('parses a file again when its text changed', () => {
    const paths = knowledgeDir()
    expect(new DataStore(paths).knowledge()[0]?.name).toBe('PLA')
    writeFileSync(join(paths.knowledgeDir, 'pla.yaml'), 'kind: filament\nid: pla\nname: PLA+\n')
    const again = new DataStore(paths).knowledge()[0]
    expect(again?.name).toBe('PLA+')
    expect(again?.data).toEqual({ kind: 'filament', id: 'pla', name: 'PLA+' })
  })
})
