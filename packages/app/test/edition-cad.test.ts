// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition without the modeling tools (features.cad off) ships a geometry engine without them, so the app offers
// none of them: no face shape or text tool, sketch, push and pull, fillet, hole or thread tool or kept dimensions. Measure,
// arrays, subtract and the mesh tools stay.
import { afterEach, describe, expect, it } from 'vitest'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { plateCommands } from '../src/plate/commands'

const ids = () => plateCommands(() => ({ id: 'slicerx' }), undefined).map((c) => c.id)
const MODELING = ['object-text', 'object-shape', 'object-sketch', 'object-push', 'object-fillet', 'object-holefit', 'object-thread', 'project-values', 'dimensions-show']

describe('an edition without the modeling tools', () => {
  afterEach(() => setCurrentEdition(NEUTRAL))

  it('offers them by default', () => {
    expect(ids()).toEqual(expect.arrayContaining(MODELING))
  })

  it('leaves them out, and keeps the tools every engine has', () => {
    setCurrentEdition({ ...NEUTRAL, features: { ...NEUTRAL.features, cad: false } })
    const left = ids()
    for (const id of MODELING) expect(left).not.toContain(id)
    expect(left).toEqual(expect.arrayContaining(['object-measure', 'object-subtract']))
  })
})
