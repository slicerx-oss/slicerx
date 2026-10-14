// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design tools expose unresolved face references without applying a replacement edit.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearReplayCache, HISTORY_VERSION, IDENTITY, type History, type HistoryMesh } from '@slicerx/cad-history'
import { expect, it } from 'vitest'
import { Designs } from '../src/design'
import { designToolset } from '../src/toolset'

it('reports a missing face reference to MCP and keeps the geometry unchanged', async () => {
  clearReplayCache()
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-face-repair-'))
  const calls: string[] = []
  const base: HistoryMesh = { name: 'Face', slot: 1, positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }
  const history: History = { version: HISTORY_VERSION, base: [base], steps: [{ id: 'push', part: 0, transform: [...IDENTITY], params: { op: 'face.push', at: [1, 1, 0], normal: [0, 0, 1], faceKey: 1, distanceMm: 2 } }] }
  const host = new Designs({ engine: async (op) => { calls.push(op); throw new Error('unexpected geometry edit') }, policy: { allowDirs: [dir], allowUrls: false, outDir: dir } })
  try {
    const d = await host.create('Face repair', [base], history)
    const tool = designToolset(host).find((t) => t.name === 'design.steps')!
    const result = await tool.run({ design: d.id } as never, {} as never)
    expect(result.output).toMatchObject({ steps: [{ state: 'broken', message: expect.stringMatching(/missing.*repair/i) }] })
    expect(d.parts[0]?.positions).toEqual(base.positions)
    expect(d.history.steps[0]?.broken).toMatch(/missing.*repair/i)
    expect(calls).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
