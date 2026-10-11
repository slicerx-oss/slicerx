// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { prefsWriter } from '../src/host/prefs'

describe('the shell prefs writer', () => {
  it('keeps one write in flight and then sends only the latest', async () => {
    const sent: string[] = []
    const done: (() => void)[] = []
    const write = prefsWriter((json) => {
      sent.push(json)
      return new Promise<void>((r) => done.push(r))
    })
    write('a')
    write('b')
    write('c')
    expect(sent).toEqual(['a'])
    done.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual(['a', 'c'])
    done.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual(['a', 'c'])
  })

  it('goes on after a failed write', async () => {
    const sent: string[] = []
    const write = prefsWriter((json) => {
      sent.push(json)
      return json === 'a' ? Promise.reject(new Error('disk')) : Promise.resolve()
    })
    write('a')
    write('b')
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual(['a', 'b'])
  })
})
