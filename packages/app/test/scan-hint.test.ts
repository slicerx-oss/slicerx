// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When a scan finds nothing on Windows, a firewall prompt that was dismissed is a likely cause: the listener for
// printer announcements is blocked, while entering the IP address still works.
import { describe, expect, it } from 'vitest'
import { noAnswerHint } from '../src/first-run/printer-step'

describe('the hint when no printer answered', () => {
  it('names the Windows firewall prompt on Windows', () => {
    const w = noAnswerHint(true)
    expect(w).toMatch(/firewall/i)
    expect(w).toMatch(/IP address/)
  })
  it('stays as it was elsewhere', () => {
    expect(noAnswerHint(false)).not.toMatch(/firewall/i)
    expect(noAnswerHint(false)).toMatch(/same network/)
  })
})
