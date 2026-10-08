// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The bridge scripts' shared first run (scripts/first-run.mjs) against a stand-in for the screens it steps through.
import { describe, expect, it } from 'vitest'
import { finishFirstRun } from '../scripts/first-run.mjs'

/** Screens as the test ids on them; each click moves on to the screen that answer leads to. */
function app(screens: Record<string, Record<string, number>>, start: string, next: Record<string, string>) {
  let at = start
  const clicks: string[] = []
  return {
    clicks,
    testids: async () => screens[at]!,
    click: async (id: string) => {
      clicks.push(id)
      if (next[`${at}:${id}`]) at = next[`${at}:${id}`]!
    },
  }
}

const sleep = async () => undefined

describe('first run', () => {
  it('accepts the agreement, skips setup and stops at the plate', async () => {
    const a = app(
      { agreement: { 'agreement-check': 1, 'agreement-accept': 1 }, setup: { 'setup-skip-all': 1 }, plate: { 'objects-list': 1 } },
      'agreement',
      { 'agreement:agreement-accept': 'setup', 'setup:setup-skip-all': 'plate' },
    )
    const r = await finishFirstRun({ ...a, sleep })
    expect(r.done).toBe(true)
    expect(a.clicks).toEqual(['agreement-check', 'agreement-accept', 'setup-skip-all'])
  })

  it('answers Leave when setup asks, even with the objects list behind the dialog', async () => {
    const a = app({ asking: { 'objects-list': 1, 'setup-leave-dialog': 1, 'setup-leave': 1, 'setup-stay': 1 }, plate: { 'objects-list': 1 } }, 'asking', { 'asking:setup-leave': 'plate' })
    const r = await finishFirstRun({ ...a, sleep })
    expect(r.done).toBe(true)
    expect(a.clicks).toEqual(['setup-leave'])
  })

  it('gives up after its tries and says what was on screen', async () => {
    const a = app({ stuck: { 'something-else': 1 } }, 'stuck', {})
    const r = await finishFirstRun({ ...a, sleep, tries: 3 })
    expect(r).toEqual({ done: false, ids: { 'something-else': 1 } })
  })
})
