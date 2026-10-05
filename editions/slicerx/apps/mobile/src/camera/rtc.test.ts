// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { feedsFor, type PairedCamera } from './feed'
import type { RtcApi, RtcChannel, RtcPeer } from './webrtc'

function fakeApi(state: 'connected' | 'failed') {
  const made: { pc: RtcPeer; channel: { cb?: (e: { data: unknown }) => void }; closed: () => boolean }[] = []
  class Peer implements RtcPeer {
    localDescription: { sdp?: string } | null = null
    iceGatheringState = 'complete'
    connectionState = 'new'
    private ch: { cb?: (e: { data: unknown }) => void } = {}
    private shut = false
    constructor() {
      made.push({ pc: this, channel: this.ch, closed: () => this.shut })
    }
    addTransceiver() {
      return {}
    }
    createDataChannel(): RtcChannel {
      return { binaryType: '', addEventListener: (_t, cb) => void (this.ch.cb = cb) }
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0 offer' }
    }
    async setLocalDescription(d: { sdp?: string }) {
      this.localDescription = d
    }
    async setRemoteDescription() {
      this.connectionState = state
    }
    addEventListener() {}
    close() {
      this.shut = true
    }
  }
  return { api: { RTCPeerConnection: Peer } as unknown as RtcApi, made }
}

function camera(remote: boolean, rtc: PairedCamera['rtc']): PairedCamera & { opened: jest.Mock } {
  const opened = jest.fn(async () => ({ stream: 3, quality: 'low' as const }))
  return {
    opened,
    open: opened,
    setQuality: async (_s, quality) => ({ quality }),
    close: jest.fn(async () => undefined),
    onFrame: () => () => undefined,
    onStats: () => () => undefined,
    onEnded: () => () => undefined,
    remote: async () => remote,
    ...(rtc ? { rtc } : {}),
  }
}

const stillsOnly = { snapshotUri: async () => 'data:image/jpeg;base64,QQ==' }

it("uses the hub's own STUN server, never a third party's", async () => {
  const { api } = fakeApi('connected')
  const seen: unknown[] = []
  const Orig = api.RTCPeerConnection as unknown as new (c: unknown) => unknown
  ;(api as { RTCPeerConnection: unknown }).RTCPeerConnection = function (c: unknown) {
    seen.push(c)
    return new Orig(c)
  }
  const cam = { ...camera(true, jest.fn(async () => ({ stream: 9, sdp: 'v=0 answer' }))), stun: async () => 'relay.example.test:3478' }
  await feedsFor({ ...stillsOnly, camera: () => cam }, api).open('bay-1', { quality: 'low' })
  expect(JSON.stringify(seen)).toContain('stun:relay.example.test:3478')
  expect(JSON.stringify(seen)).not.toContain('google')
})

it('away from home, a direct path carries JPEG pictures from the data channel', async () => {
  const { api, made } = fakeApi('connected')
  const rtc = jest.fn(async () => ({ stream: 9, sdp: 'v=0 answer' }))
  const cam = camera(true, rtc)
  const feed = await feedsFor({ ...stillsOnly, camera: () => cam }, api).open('bay-1', { quality: 'low' })
  expect(rtc).toHaveBeenCalledWith('bay-1', 'v=0 offer')
  expect(cam.opened).not.toHaveBeenCalled()
  expect(feed.capMs).toBe(30 * 60_000)
  const got: string[] = []
  feed.onFrame((f) => got.push(f.uri))
  made[0]?.channel.cb?.({ data: new Uint8Array([65, 66, 67]).buffer })
  expect(got).toEqual(['data:image/jpeg;base64,QUJD'])
  feed.close()
  expect(made[0]?.closed()).toBe(true)
})

it('falls back to sealed JPEG through the relay when the direct path fails', async () => {
  const { api, made } = fakeApi('failed')
  const cam = camera(true, async () => ({ stream: 9, sdp: 'v=0 answer' }))
  const feed = await feedsFor({ ...stillsOnly, camera: () => cam }, api).open('bay-1', { quality: 'low' })
  expect(made[0]?.closed()).toBe(true)
  expect(cam.opened).toHaveBeenCalled()
  expect(feed.mode).toBe('live')
  expect(feed.capMs).toBe(10 * 60_000)
})

it('at home it never starts WebRTC', async () => {
  const { api, made } = fakeApi('connected')
  const rtc = jest.fn()
  const cam = camera(false, rtc)
  const feed = await feedsFor({ ...stillsOnly, camera: () => cam }, api).open('bay-1', { quality: 'low' })
  expect(made).toHaveLength(0)
  expect(rtc).not.toHaveBeenCalled()
  expect(feed.capMs).toBeUndefined()
})

it('uses sealed JPEG when the app has no native WebRTC module', async () => {
  const cam = camera(true, async () => ({ stream: 9, sdp: 'x' }))
  const feed = await feedsFor({ ...stillsOnly, camera: () => cam }, null).open('bay-1', { quality: 'low' })
  expect(cam.opened).toHaveBeenCalled()
  expect(feed.capMs).toBe(10 * 60_000)
})
