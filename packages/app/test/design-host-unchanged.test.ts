// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step that did not go through on the app's plate says the design is unchanged once, even when its reason (an
// exact replay that stopped) says so already.
import { describe, expect, it } from 'vitest'
import { notThrough } from '../src/cad/design-host'

describe('a step that did not go through', () => {
  it('says the design is unchanged once when the reason already says it', () => {
    const why = 'Exact replay stopped: The exact kernel cannot fillet this body yet. The design is unchanged.'
    expect(notThrough(why)).toBe('The step did not go through: Exact replay stopped: The exact kernel cannot fillet this body yet. The design is unchanged.')
    expect(notThrough(`${why}  `)).toBe(notThrough(why))
    expect(notThrough(why).match(/The design is unchanged/g)).toHaveLength(1)
  })

  it('adds it to a reason that does not say it, as before', () => {
    expect(notThrough('The shape no longer reaches the part.')).toBe('The step did not go through: The shape no longer reaches the part. The design is unchanged.')
    expect(notThrough('the steps before it are broken')).toBe('The step did not go through: the steps before it are broken. The design is unchanged.')
  })
})
