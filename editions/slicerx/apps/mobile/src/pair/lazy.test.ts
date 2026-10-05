// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { feedsFor, type PairedCamera, type PairedCameraFrame } from '../camera/feed'
import { lazyCamera, lazyPush } from './lazy'

function fakeCamera() {
  const frameCbs = new Set<(f: PairedCameraFrame) => void>()
  const cam: PairedCamera = {
    open: jest.fn(async () => ({ stream: 7, quality: 'low' as const })),
    setQuality: jest.fn(async (_s, quality) => ({ quality })),
    close: jest.fn(async () => undefined),
    onFrame: (cb) => {
      frameCbs.add(cb)
      return () => void frameCbs.delete(cb)
    },
    onStats: () => () => undefined,
    onEnded: () => () => undefined,
  }
  return { cam, frameCbs }
}

it('opens a paired stream through the lazy camera and draws its frames', async () => {
  const { cam, frameCbs } = fakeCamera()
  const host = { camera: jest.fn(async () => cam as never) }
  const feeds = feedsFor({ snapshotUri: async () => null, camera: () => lazyCamera(host as never) })
  const feed = await feeds.open('bay-1', { quality: 'low' })
  expect(feed.mode).toBe('live')
  const got: string[] = []
  feed.onFrame((f) => got.push(f.uri))
  await new Promise((r) => setTimeout(r, 0))
  for (const cb of frameCbs) cb({ stream: 7, capturedAt: 1, key: true, kind: 'jpeg', dataB64: 'QUJD' })
  expect(got).toEqual(['data:image/jpeg;base64,QUJD'])
  feed.close()
  await new Promise((r) => setTimeout(r, 0))
  expect(cam.close).toHaveBeenCalledWith(7)
  expect(host.camera).toHaveBeenCalledTimes(1)
})

it('falls back to stills when the computer has no camera', async () => {
  const host = { camera: async () => null }
  const feeds = feedsFor({ snapshotUri: async () => 'data:image/jpeg;base64,QQ==', camera: () => lazyCamera(host as never) })
  const feed = await feeds.open('bay-1', { quality: 'low' })
  expect(feed.mode).toBe('stills')
  feed.close()
})

it('registers push through the connection and rejects when the hub sends none', async () => {
  const reg = { register: jest.fn(async () => undefined), unregister: jest.fn(async () => undefined) }
  const prefs = { printDone: true, printFailed: true, attention: true, approvals: true } as never
  await lazyPush({ push: async () => reg as never }).register({ token: 'ExponentPushToken[x]', platform: 'ios', prefs })
  expect(reg.register).toHaveBeenCalled()
  await expect(lazyPush({ push: async () => null }).unregister('t')).rejects.toThrow('no alerts')
})
