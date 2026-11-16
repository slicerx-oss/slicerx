// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment node
// An exact solid op's request is made into text before anything is written into the engine, so one that cannot be
// leaves the engine as it was.
import { expect, it, vi } from 'vitest'
import { callEngine, type GeomExports } from '../src/geom/engine-call'

it('serializes before writing the request into the engine', () => {
  const cycle: Record<string, unknown> = {}
  cycle['self'] = cycle
  for (const request of [cycle, { value: 1n }, { toJSON() { throw new Error('serialize') } }, { toJSON() { return undefined } }]) {
    const input = vi.fn(() => 0)
    const x = { geom_input: input, geom_call: vi.fn(() => 0) } as unknown as GeomExports
    expect(() => callEngine(x, 'brep.box', request)).toThrow()
    expect(input).not.toHaveBeenCalled()
  }
})
