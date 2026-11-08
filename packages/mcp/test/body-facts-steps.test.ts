// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every kind of step the design history records is either one that builds shape, which may stand for any planned
// feature when it has no name of its own, or one that finishes what was built. The ops are read from the history's
// own naming code, so a new kind of step fails here until it is sorted into one of the two.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUILDS, FINISHES } from '../src/body-facts'

const model = readFileSync(fileURLToPath(new URL('../../cad-history/src/model.ts', import.meta.url)), 'utf8')

/** The ops madeName names, one case each: every step the history can record. */
function recordedOps(): string[] {
  const start = model.indexOf('export function madeName(')
  const body = model.slice(start, model.indexOf('\n}\n', start))
  return [...body.matchAll(/case '([a-z.]+)':/g)].map((m) => m[1]!)
}

describe('the kinds of step design.check reads', () => {
  it('reads the ops from the history code', () => {
    expect(recordedOps().length).toBeGreaterThan(20)
    expect(recordedOps()).toEqual(expect.arrayContaining(['shape.extrude', 'parts.add', 'subtract', 'edge.fillet', 'paint']))
  })

  it('sorts every recorded op into exactly one set, and names no op the history lacks', () => {
    const ops = recordedOps()
    for (const op of ops) expect(Number(BUILDS.has(op)) + Number(FINISHES.has(op)), op).toBe(1)
    expect([...BUILDS, ...FINISHES].filter((op) => !ops.includes(op))).toEqual([])
  })
})
