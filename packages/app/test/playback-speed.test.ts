// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAYBACK_SPEED, PLAYBACK_SPEEDS, normalizePrefs } from '../src/state/prefs'

describe('Preview playback speed', () => {
  it('plays a first view at half speed, since a fast printer at real speed is too quick to follow', () => {
    expect(DEFAULT_PLAYBACK_SPEED).toBe(0.5)
    expect(normalizePrefs({}).playbackSpeed).toBe(0.5)
  })

  it('offers slow motion through a whole print, real time among them', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.25, 0.5, 1, 2, 5, 10, 50, 100])
    expect(PLAYBACK_SPEEDS).toContain(DEFAULT_PLAYBACK_SPEED)
  })

  it('keeps the last speed chosen, and falls back to the default for one it no longer offers', () => {
    expect(normalizePrefs({ playbackSpeed: 2 }).playbackSpeed).toBe(2)
    expect(normalizePrefs({ playbackSpeed: 0.25 }).playbackSpeed).toBe(0.25)
    expect(normalizePrefs({ playbackSpeed: 500 }).playbackSpeed).toBe(0.5)
    expect(normalizePrefs({ playbackSpeed: '2' }).playbackSpeed).toBe(0.5)
  })

  it('keeps the camera where the user put it unless they ask it to follow the nozzle', () => {
    expect(normalizePrefs({}).followNozzle).toBe(false)
    expect(normalizePrefs({ followNozzle: true }).followNozzle).toBe(true)
  })
})
