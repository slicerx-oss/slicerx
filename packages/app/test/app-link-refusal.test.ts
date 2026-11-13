// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design tool that answers a call as failed says so over the app link too: its reply carries ok false with the
// tool's own words, so a client reading ok, or the MCP server's isError, does not take it for a success. A tool that
// went through answers as before, with no ok in its reply. The engine is a stand-in: the sketch check's answer is all
// the test needs.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { setGeomProvider } from '../src/geom/client'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

const square = [[0, 0], [10, 0], [10, 10], [0, 10]]
const open = [[0, 0], [10, 0], [10, 10]]

beforeAll(async () => {
  setGeomProvider({
    async call<T>(op: string, request: unknown): Promise<T> {
      if (op !== 'sketch.check') throw new Error(`no stand-in for ${op}`)
      const closed = JSON.stringify(request).includes('[0,10]')
      return (closed ? { ok: true, areaMm2: 100, issues: [] } : { ok: false, issues: [{ kind: 'open', loop: 0 }] }) as T
    },
  })
  await useDesignHost(loader)
})
afterAll(() => setGeomProvider(null))

it('answers a failed sketch check with ok false and the tool words, and a passed one as before', async () => {
  expect(await runCall('geom.sketch_check', { loops: [{ points: open }] })).toMatchObject({ ok: false, summary: 'The sketch has 1 problem(s)' })
  const passed = (await runCall('geom.sketch_check', { loops: [{ points: square }] })) as Record<string, unknown>
  expect(passed).toMatchObject({ summary: 'The sketch is closed, 100 mm2' })
  expect(passed).not.toHaveProperty('ok')
})
