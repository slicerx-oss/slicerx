// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Direct live video from the paired computer over WebRTC, for a phone away from home. The phone
// sends one complete offer (all candidates gathered, no trickle) inside the sealed pair session
// (`camera.rtc`); the hub answers and media then flows peer to peer. H.264 cameras arrive as a
// video track, JPEG cameras as pictures on a data channel. The hub ends a stream after 30 minutes.
// When the direct path does not come up, `open` rejects and the caller uses `camera.open`.
import type { CameraFeeds, Feed, FeedFrame, FeedQuality, FeedStats, PairedCamera } from './feed'
import type { RtcApi, RtcPeer } from './webrtc'

export const RTC_MAX_MS = 30 * 60_000
const GATHER_MS = 4000
const CONNECT_MS = 10_000
/**
 * The hub names its own STUN server (`host.info.stun`, next to the relay). No third party sees the
 * address of this phone or the computer; without one, host candidates and the hub's own are used.
 */
const iceServers = (stun: string | null) => (stun ? [{ urls: `stun:${stun.replace(/^stuns?:/, '')}` }] : [])

type Timer = ReturnType<typeof setTimeout>
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function gathered(pc: RtcPeer): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const t: Timer = setTimeout(resolve, GATHER_MS)
    pc.addEventListener('icegatheringstatechange', (() => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t)
        resolve()
      }
    }) as never)
  })
}

export function rtcFeeds(camera: PairedCamera, api: RtcApi, o: { now?: () => number } = {}): CameraFeeds {
  const now = o.now ?? (() => Date.now())
  return {
    async open(printerId, { quality }): Promise<Feed> {
      if (!camera.rtc) throw new Error('This computer has no direct video')
      const stun = await camera.stun?.().catch(() => null)
      const pc = new api.RTCPeerConnection({ iceServers: iceServers(stun ?? null) })
      const frames = new Set<(f: FeedFrame) => void>()
      const ended = new Set<() => void>()
      let closed = false
      let stream = -1
      let count = 0
      const emitFrame = (f: FeedFrame) => {
        count++
        for (const cb of frames) cb(f)
      }
      const end = () => {
        if (closed) return
        for (const cb of ended) cb()
      }
      try {
        pc.addTransceiver('video', { direction: 'recvonly' })
        const dc = pc.createDataChannel('jpeg')
        dc.binaryType = 'arraybuffer'
        dc.addEventListener('message', (e) => {
          const d = e.data
          if (d instanceof ArrayBuffer) emitFrame({ uri: `data:image/jpeg;base64,${base64(new Uint8Array(d))}`, at: now() })
        })
        pc.addEventListener('track', ((e: { streams?: { toURL?: () => string }[] }) => {
          const url = e.streams?.[0]?.toURL?.()
          if (url) emitFrame({ uri: '', rtcStream: url, at: now() })
        }) as never)
        pc.addEventListener('connectionstatechange', (() => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') end()
        }) as never)

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await gathered(pc)
        const sdp = pc.localDescription?.sdp
        if (!sdp) throw new Error('No offer to send')
        const answer = await camera.rtc(printerId, sdp)
        stream = answer.stream
        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
        // The path is up when the peers connect; a hub that cannot be reached directly never does.
        const until = now() + CONNECT_MS
        while (pc.connectionState !== 'connected' && now() < until) {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') break
          await wait(200)
        }
        if (pc.connectionState !== 'connected') throw new Error('No direct path to the computer')
      } catch (e) {
        closed = true
        if (stream >= 0) void camera.close(stream).catch(() => undefined)
        pc.close()
        throw e
      }
      const offEnded = camera.onEnded((e) => {
        if (e.stream === stream) end()
      })
      const stats = new Set<(s: FeedStats) => void>()
      let q: FeedQuality = quality
      const timer = setInterval(() => {
        const s: FeedStats = { fps: count, kbps: 0, quality: q }
        count = 0
        for (const cb of stats) cb(s)
      }, 1000)
      return {
        mode: 'live',
        capMs: RTC_MAX_MS,
        get quality() {
          return q
        },
        onFrame: (cb) => {
          frames.add(cb)
          return () => void frames.delete(cb)
        },
        onStats: (cb) => {
          stats.add(cb)
          return () => void stats.delete(cb)
        },
        onEnded: (cb) => {
          ended.add(cb)
          return () => void ended.delete(cb)
        },
        // The direct path sends what the camera sends; quality is a hint for the fallback only.
        async setQuality(next) {
          q = next
        },
        close() {
          if (closed) return
          closed = true
          clearInterval(timer)
          offEnded()
          void camera.close(stream).catch(() => undefined)
          pc.close()
        },
      }
    },
  }
}
