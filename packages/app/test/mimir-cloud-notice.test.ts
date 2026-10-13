// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The notice before the first chat on mimir cloud: when it is due, that it names the edition, and that its switch is
// the Settings one and Start is remembered.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { NEUTRAL, currentEdition, setCurrentEdition } from '../src/edition'
import { CLOUD_NOTICE_VERSION, CloudNotice, cloudNoticeDue } from '../src/pilot-connect/cloud-notice'
import { normalizePrefs } from '../src/state/prefs'
import { get, set } from '../src/state/store'

const CLOUD = { ...NEUTRAL, ai: { ...NEUTRAL.ai, keySource: 'cloud' as const }, backend: { ...NEUTRAL.backend, supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-supabase-dashboard' } } }

afterEach(cleanup)

describe('the mimir cloud notice', () => {
  it('is due only where mimir would answer on mimir cloud, until it is read', () => {
    const s = { pilot: null, setupPilotOff: false, mimirNotice: null }
    expect(cloudNoticeDue(CLOUD, s, true)).toBe(true)
    expect(cloudNoticeDue(CLOUD, { ...s, pilot: { mode: 'unset' as const } }, true)).toBe(true)
    expect(cloudNoticeDue(CLOUD, { ...s, mimirNotice: CLOUD_NOTICE_VERSION }, true)).toBe(false)
    // an older notice shows again
    expect(cloudNoticeDue(CLOUD, { ...s, mimirNotice: CLOUD_NOTICE_VERSION - 1 }, true)).toBe(true)
    // the person's own key, mimir off, a shell without the cloud, an edition without it
    expect(cloudNoticeDue(CLOUD, { ...s, pilot: { mode: 'on' as const, provider: 'anthropic' as const } }, true)).toBe(false)
    expect(cloudNoticeDue(CLOUD, { ...s, pilot: { mode: 'off' as const } }, true)).toBe(false)
    expect(cloudNoticeDue(CLOUD, s, false)).toBe(false)
    expect(cloudNoticeDue(NEUTRAL, s, true)).toBe(false)
  })

  it("names the edition, shares the Settings switch, and remembers Start", () => {
    const before = currentEdition()
    const was = { mimirShare: get().mimirShare, mimirNotice: get().mimirNotice }
    try {
      setCurrentEdition({ ...CLOUD, brand: { ...CLOUD.brand, name: 'LayerMate' } })
      set({ mimirShare: true, mimirNotice: null })
      render(createElement(CloudNotice))
      const notice = screen.getByTestId('mimir-cloud-notice')
      expect(notice.textContent).toMatch(/mimir in LayerMate runs on a cloud model provider/)
      expect(notice.textContent).toMatch(/LayerMate keeps your mimir sessions for 180 days to improve mimir\. You can turn that off here, or later in Settings > mimir\./)
      const sw = screen.getByTestId('mimir-notice-share')
      expect(sw.getAttribute('aria-checked')).toBe('true')
      act(() => fireEvent.click(sw))
      expect(get().mimirShare).toBe(false)
      act(() => fireEvent.click(screen.getByTestId('mimir-notice-ok')))
      expect(get().mimirNotice).toBe(CLOUD_NOTICE_VERSION)
    } finally {
      setCurrentEdition(before)
      set(was)
    }
  })

  it('keeps the read version in prefs, and drops a bad one', () => {
    expect(normalizePrefs({ mimirNotice: 1 }).mimirNotice).toBe(1)
    expect(normalizePrefs({ mimirNotice: 'yes' }).mimirNotice).toBeUndefined()
    expect(normalizePrefs({}).mimirShare).toBe(true)
  })
})
