// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A camera view with no picture: the ravens spar while it connects, and rest over one short line with the reason in a tip.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { setMotionPreference } from '@slicerx/ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BATTLE_MIN_MS, CameraIdle, CameraProblem, forgetFirstLooks, shortReason, useFirstLook, type FirstLook } from '../src/camera/idle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(props: Parameters<typeof CameraIdle>[0]): HTMLElement {
  const el = document.createElement('div')
  const root = createRoot(el)
  act(() => root.render(createElement(CameraIdle, props)))
  return el
}

describe('short camera reasons', () => {
  it('says each known reason in a few words', () => {
    expect(shortReason('The printer refused the camera login. Check the access code on the printer screen.')).toBe('Camera login refused')
    expect(shortReason("This computer cannot decode the camera's video (H.264, avc1.640033).")).toBe('Video format not supported')
    expect(shortReason('The camera stopped sending video.')).toBe('The camera stopped')
    expect(shortReason('No picture from the camera after 10 seconds.')).toBe('No picture')
  })

  it('keeps a short first sentence and falls back to No picture for a long one', () => {
    expect(shortReason('No signal')).toBe('No signal')
    expect(shortReason('WebRTC connection timed out')).toBe('WebRTC connection timed out')
    expect(shortReason('Something went wrong somewhere between the printer and this computer, try again.')).toBe('No picture')
  })
})

describe('camera idle', () => {
  it('shows huginn and muninn sparring in the rune ring while connecting, busy', () => {
    const el = render({ connecting: true, text: 'Connecting to the camera', size: 'lg' })
    const idle = el.querySelector<HTMLElement>('.cam-idle')!
    expect(idle.dataset['connecting']).toBe('true')
    expect(idle.getAttribute('aria-busy')).toBe('true')
    expect(idle.querySelectorAll('.rb-scene .rb-body')).toHaveLength(2)
    expect(idle.querySelectorAll('.rb-ring path')).toHaveLength(24)
    expect(idle.querySelector('.cam-idle-line')!.textContent).toBe('Connecting to the camera')
    expect(idle.querySelector('.cam-idle-names')!.textContent).toBe('huginn · muninn')
  })

  it('gives a tile the whole ground and says it to readers only', () => {
    const idle = render({ connecting: true, text: 'Connecting to the camera' }).querySelector<HTMLElement>('.cam-idle')!
    expect(idle.querySelector('.cam-idle-line')).toBeNull()
    expect(idle.getAttribute('aria-label')).toBe('Connecting to the camera')
    expect(idle.querySelector('.rb-scene')).toBeTruthy()
  })

  it('rests with a short line and puts the reason in a tip, or under it when asked', () => {
    const reason = 'The printer refused the camera login. Check the access code.'
    const line = render({ text: shortReason(reason), detail: reason }).querySelector<HTMLElement>('.cam-idle-line')!
    expect(line.textContent).toBe('Camera login refused')
    expect(line.dataset['tipBody']).toBe(reason)
    const shown = render({ text: shortReason(reason), detail: reason, showDetail: true })
    expect(shown.querySelector('.cam-idle-line')!.hasAttribute('data-tip-body')).toBe(false)
    expect(shown.querySelector('.cam-idle-detail')!.textContent).toBe(reason)
    expect(shown.querySelector('.cam-idle')!.hasAttribute('data-connecting')).toBe(false)
    expect(shown.querySelectorAll('.cam-ravens svg.cam-raven')).toHaveLength(2)
    expect(shown.querySelector('.rb-scene')).toBeNull()
  })
})

describe('first look', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // renders the hook and reports each look it gives
  function probe(first: boolean) {
    const seen: FirstLook[] = []
    const el = document.createElement('div')
    const root = createRoot(el)
    const Probe = ({ ready, k }: { ready: boolean; k: string }) => {
      seen.push(useFirstLook(ready, k, first))
      return null
    }
    const show = (ready: boolean, k = 'a') => act(() => root.render(createElement(Probe, { ready, k })))
    return { seen, show, last: () => seen[seen.length - 1] }
  }

  it('holds a picture that is ready at once for one clash, then crosses over', () => {
    vi.useFakeTimers()
    const p = probe(true)
    p.show(true)
    expect(p.last()).toBe('hold')
    act(() => void vi.advanceTimersByTime(BATTLE_MIN_MS - 50))
    expect(p.last()).toBe('hold')
    act(() => void vi.advanceTimersByTime(50))
    expect(p.last()).toBe('fade')
    act(() => void vi.advanceTimersByTime(200))
    expect(p.last()).toBe('done')
    // a later still or reconnect on the same view never holds again
    p.show(false)
    p.show(true)
    expect(p.last()).toBe('done')
  })

  it('crosses as soon as a slow picture arrives after the clash', () => {
    vi.useFakeTimers()
    const p = probe(true)
    p.show(false)
    act(() => void vi.advanceTimersByTime(3000))
    expect(p.last()).toBe('hold')
    p.show(true)
    expect(p.last()).toBe('fade')
  })

  it('keeps holding when first turns off mid-hold, as a tile does once its first still is remembered', () => {
    vi.useFakeTimers()
    const seen: FirstLook[] = []
    const el = document.createElement('div')
    const root = createRoot(el)
    const Probe = ({ first }: { first: boolean }) => {
      seen.push(useFirstLook(true, 'a', first))
      return null
    }
    act(() => root.render(createElement(Probe, { first: true })))
    act(() => root.render(createElement(Probe, { first: false })))
    expect(seen[seen.length - 1]).toBe('hold')
    act(() => void vi.advanceTimersByTime(BATTLE_MIN_MS))
    expect(seen[seen.length - 1]).toBe('fade')
  })

  it('holds once per session under a once key', () => {
    vi.useFakeTimers()
    forgetFirstLooks()
    const run = () => {
      const seen: FirstLook[] = []
      const el = document.createElement('div')
      const root = createRoot(el)
      const Probe = () => {
        seen.push(useFirstLook(true, 'p', true, 'hud:p'))
        return null
      }
      act(() => root.render(createElement(Probe)))
      act(() => void vi.advanceTimersByTime(BATTLE_MIN_MS + 250))
      act(() => root.unmount())
      return seen
    }
    expect(run()).toContain('hold')
    expect(run().every((l) => l === 'done')).toBe(true)
  })

  it('does not hold a view that opens on a remembered picture, or with reduced motion', () => {
    vi.useFakeTimers()
    const p = probe(false)
    p.show(true)
    expect(p.last()).toBe('done')
    setMotionPreference('reduced')
    const r = probe(true)
    r.show(true)
    expect(r.seen.every((l) => l === 'done')).toBe(true)
    setMotionPreference('system')
  })

  // the Remote Desktop case: the system asks for reduced motion
  for (const [choice, held] of [['system', false], ['full', true], ['reduced', false]] as const) {
    it(`holds the ravens ${held ? 'and animates them' : 'not at all'} with Motion set to ${choice} on a system that reduces motion`, () => {
      vi.useFakeTimers()
      vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
      setMotionPreference(choice)
      expect(document.documentElement.dataset['motion']).toBe(held ? 'full' : 'reduced')
      const p = probe(true)
      p.show(true)
      expect(p.last()).toBe(held ? 'hold' : 'done')
      vi.unstubAllGlobals()
      setMotionPreference('system')
    })
  }
})

describe('trying again', () => {
  afterEach(() => vi.useRealTimers())

  it('breathes the resting pair and counts down to the next try', () => {
    vi.useFakeTimers()
    const el = document.createElement('div')
    const root = createRoot(el)
    const status = { state: 'retrying' as const, attempt: 2, retryInMs: 5000, reason: 'The camera closed the connection.' }
    act(() => root.render(createElement(CameraProblem, { status, error: 'The camera connection dropped. Trying again in 5 s.' })))
    const idle = el.querySelector<HTMLElement>('.cam-idle')!
    expect(idle.hasAttribute('data-retrying')).toBe(true)
    expect(idle.querySelectorAll('.cam-ravens svg')).toHaveLength(2)
    expect(idle.querySelector('.cam-idle-line')!.textContent).toBe('Trying again in 5 s')
    expect(idle.querySelector('.cam-idle-detail')!.textContent).toBe('The camera closed the connection.')
    act(() => void vi.advanceTimersByTime(2100))
    expect(idle.querySelector('.cam-idle-line')!.textContent).toBe('Trying again in 3 s')
    act(() => void vi.advanceTimersByTime(3000))
    expect(idle.querySelector('.cam-idle-line')!.textContent).toBe('Trying again now')
    // the next try starts the count again
    act(() => root.render(createElement(CameraProblem, { status: { ...status, attempt: 3, retryInMs: 8000 }, error: '' })))
    expect(el.querySelector('.cam-idle-line')!.textContent).toBe('Trying again in 8 s')
    // back to connecting or live there is no problem to show
    act(() => root.render(createElement(CameraProblem, { status: { state: 'live' as const }, error: '' })))
    expect(el.querySelector('.cam-idle')).toBeNull()
  })

  it('keeps a tile clear and puts the countdown in the tip and the label', () => {
    vi.useFakeTimers()
    const el = document.createElement('div')
    const root = createRoot(el)
    act(() => root.render(createElement(CameraProblem, { status: { state: 'retrying' as const, attempt: 1, retryInMs: 4000 }, error: '', size: 'sm' })))
    const idle = el.querySelector<HTMLElement>('.cam-idle')!
    expect(idle.querySelector('.cam-idle-line')).toBeNull()
    expect(idle.getAttribute('aria-label')).toBe('Trying again in 4 s')
    expect(idle.dataset['tipTitle']).toBe('Trying again in 4 s')
  })
})

describe('a printer that is away', () => {
  it('remembers the last reachable report, not the offline one', async () => {
    const { forgetSeen, lastSeenAt, noteStatus } = await import('../src/lib/last-seen')
    forgetSeen()
    const st = (state: string, updatedAt: string) => ({ printerId: 'p', state, updatedAt, nozzles: [], slots: [], cameraAvailable: false }) as never
    noteStatus(st('idle', '2026-10-05T11:50:00Z'))
    noteStatus(st('offline', '2026-10-05T11:59:00Z'))
    expect(lastSeenAt('p')).toBe('2026-10-05T11:50:00Z')
  })

  it('says when it was last seen in plain words', async () => {
    const { lastSeen } = await import('../src/features/fleet/offline')
    const now = Date.parse('2026-10-05T12:00:00Z')
    expect(lastSeen('2026-10-05T11:59:30Z', now)).toBe('Lost the connection')
    expect(lastSeen('2026-10-05T11:56:00Z', now)).toBe('Last seen 4 min ago')
    expect(lastSeen('2026-10-05T09:00:00Z', now)).toBe('Last seen 3 h ago')
    expect(lastSeen('2026-10-04T12:00:00Z', now)).toBe('Last seen 1 day ago')
    expect(lastSeen(undefined, now)).toBe('Not seen on this computer yet')
  })

  it('says why a camera that failed for good shows nothing, without a countdown', () => {
    const el = document.createElement('div')
    const root = createRoot(el)
    act(() => root.render(createElement(CameraProblem, { status: { state: 'failed' as const, reason: 'The printer refused the camera login. Check the access code.' }, error: '' })))
    expect(el.querySelector('.cam-idle-line')!.textContent).toBe('Camera login refused')
    expect(el.querySelector('.cam-idle')!.hasAttribute('data-breathe')).toBe(false)
    act(() => root.unmount())
  })
})
