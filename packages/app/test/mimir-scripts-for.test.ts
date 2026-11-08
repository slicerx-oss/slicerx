// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scripted replies a build answers with: one made for the end-to-end tests has every script, any other leaves out
// those that exist only to show a line on screen, so a person without a model reaches only the parts the stub offers.
import { describe, expect, it } from 'vitest'
import { scriptsFor } from '../src/workspaces/mimir/scripted'
import { SCRIPTS } from '../src/workspaces/mimir/scripts'

const answers = (e2e: boolean, message: string): string | undefined => scriptsFor(SCRIPTS, e2e).find((s) => s.match.test(message))?.id

describe('scripts a build answers with', () => {
  it('answers a mounting plate only in the build for the end-to-end tests', () => {
    expect(answers(true, 'Design a mounting plate with four screw holes')).toBe('mounting-plate')
    expect(answers(false, 'Design a mounting plate with four screw holes')).toBeUndefined()
  })

  it('keeps every other script in both builds', () => {
    const others = SCRIPTS.filter((s) => !s.testOnly).map((s) => s.id)
    expect(scriptsFor(SCRIPTS, false).map((s) => s.id)).toEqual(others)
    expect(scriptsFor(SCRIPTS, true).map((s) => s.id)).toEqual(SCRIPTS.map((s) => s.id))
    expect(others).toContain('backplate')
  })
})
