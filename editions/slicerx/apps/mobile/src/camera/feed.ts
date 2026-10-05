// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Live printer video for the phone, behind one seam. A feed hands out frames as image URIs; the
// view draws them. Two sources exist today: the paired computer's camera stream (camera.* on the
// paired channel, JPEG frames) when the connection offers it, and stills polled from
// `snapshotUri` for everything else, including the demo fleet. Nothing here touches the screen.
import type { SwitchablePrinters } from '../host'
import { rtcFeeds } from './rtc'
import { loadWebRtc, type RtcApi } from './webrtc'

export type FeedQuality = 'low' | 'medium' | 'high'
export type FeedMode = 'live' | 'stills'

export interface FeedFrame {
  /** A `data:` or `file:` URI the image view can draw. */
  uri: string
  /** Epoch ms when the camera (or the bridge) took the frame. */
  at: number
  /** A live video stream for the native video view (WebRTC with an H.264 camera). `uri` is empty then. */
  rtcStream?: string
}

export interface FeedStats {
  fps: number
  kbps: number
  quality: FeedQuality
}

export interface Feed {
  /** The source stops by itself after this long (the hub's cap); the viewer opens a new one just before. */
  readonly capMs?: number | undefined
  readonly mode: FeedMode
  readonly quality: FeedQuality
  onFrame(cb: (f: FeedFrame) => void): () => void
  onStats(cb: (s: FeedStats) => void): () => void
  /** The source ended: camera off, printer gone, connection closed. */
  onEnded(cb: () => void): () => void
  setQuality(q: FeedQuality): Promise<void>
  close(): void
}

export interface CameraFeeds {
  /** Rejects when the printer has no camera at all. */
  open(printerId: string, opts: { quality: FeedQuality }): Promise<Feed>
}

/** Stills per second at each level. Low is for list tiles, high for the open printer. */
export const STILLS_INTERVAL_MS: Record<FeedQuality, number> = { low: 2000, medium: 1000, high: 500 }

/**
 * The paired channel's camera stream, when the connection has one. The shape follows camera.*
 * on sx-link's bridge (packages/connect/docs/camera.md): `camera.open`, a JPEG frame per
 * `camera.frame` event, `camera.quality`, `camera.close`. Connections without it return null.
 */
export interface PairedCameraFrame {
  stream: number
  capturedAt: number
  key: boolean
  kind: 'jpeg'
  dataB64: string
}

export interface PairedCameraStats {
  stream: number
  fps: number
  kbps: number
  dropped: number
  quality: FeedQuality
}

export interface PairedCamera {
  open(printerId: string, opts: { quality: FeedQuality | 'auto' }): Promise<{ stream: number; quality: FeedQuality }>
  setQuality(stream: number, quality: FeedQuality): Promise<{ quality: FeedQuality }>
  close(stream: number): Promise<void>
  onFrame(cb: (f: PairedCameraFrame) => void): () => void
  onStats(cb: (s: PairedCameraStats) => void): () => void
  /** Direct video over WebRTC, from a hub with remote access. Absent or rejecting: use `open`. */
  rtc?(printerId: string, offer: string): Promise<{ stream: number; sdp: string }>
  /** True when the connection runs through the relay (the phone is away from home). */
  remote?(): Promise<boolean>
  /** The STUN server (`host:port`) the hub runs next to its relay; null when it names none. */
  stun?(): Promise<string | null>
  onEnded(cb: (e: { stream: number; reason?: 'ended' | 'codec' | 'closed' }) => void): () => void
}

type Listeners<T> = Set<(v: T) => void>
const emit = <T>(set: Listeners<T>, v: T): void => {
  for (const cb of set) cb(v)
}
const listen = <T>(set: Listeners<T>) => (cb: (v: T) => void) => {
  set.add(cb)
  return () => void set.delete(cb)
}

/** Frames from the paired computer's camera stream. */
/** A sealed JPEG stream through the relay ends after 10 minutes. */
export const RELAY_MAX_MS = 10 * 60_000

export function pairedFeeds(camera: PairedCamera, o: { capMs?: number } = {}): CameraFeeds {
  return {
    async open(printerId, { quality }) {
      const opened = await camera.open(printerId, { quality })
      let q = opened.quality
      const frames: Listeners<FeedFrame> = new Set()
      const stats: Listeners<FeedStats> = new Set()
      const ended: Listeners<void> = new Set()
      let count = 0
      let bytes = 0
      let last = Date.now()
      const offFrame = camera.onFrame((f) => {
        if (f.stream !== opened.stream) return
        count++
        bytes += (f.dataB64.length * 3) / 4
        emit(frames, { uri: `data:image/jpeg;base64,${f.dataB64}`, at: f.capturedAt })
      })
      const offStats = camera.onStats((s) => {
        if (s.stream !== opened.stream) return
        q = s.quality
        const now = Date.now()
        const secs = Math.max(0.25, (now - last) / 1000)
        emit(stats, { fps: Math.round(count / secs), kbps: Math.round((bytes * 8) / 1000 / secs), quality: q })
        count = 0
        bytes = 0
        last = now
      })
      const offEnded = camera.onEnded((e) => {
        if (e.stream === opened.stream) emit(ended, undefined)
      })
      let closed = false
      return {
        mode: 'live',
        capMs: o.capMs,
        get quality() {
          return q
        },
        onFrame: listen(frames),
        onStats: listen(stats),
        onEnded: listen(ended),
        async setQuality(next) {
          q = (await camera.setQuality(opened.stream, next)).quality
        },
        close() {
          if (closed) return
          closed = true
          offFrame()
          offStats()
          offEnded()
          void camera.close(opened.stream).catch(() => undefined)
        },
      }
    },
  }
}

export interface StillsOptions {
  intervals?: Partial<Record<FeedQuality, number>>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void
}

/**
 * Stills polled on a timer. Each request waits for the previous one, so a slow printer never
 * queues work. Three misses in a row end the feed.
 */
export function stillsFeeds(snapshotUri: (printerId: string) => Promise<string | null>, o: StillsOptions = {}): CameraFeeds {
  const now = o.now ?? (() => Date.now())
  const setTimer = o.setTimer ?? setTimeout
  const clearTimer = o.clearTimer ?? clearTimeout
  return {
    async open(printerId, { quality }) {
      const first = await snapshotUri(printerId)
      if (first === null) throw new Error('No camera on this printer')
      let q = quality
      const frames: Listeners<FeedFrame> = new Set()
      const stats: Listeners<FeedStats> = new Set()
      const ended: Listeners<void> = new Set()
      let timer: ReturnType<typeof setTimeout> | null = null
      let closed = false
      let misses = 0
      let delivered = 0
      let statAt = now()
      const interval = () => o.intervals?.[q] ?? STILLS_INTERVAL_MS[q]
      const tick = async () => {
        if (closed) return
        try {
          const uri = await snapshotUri(printerId)
          if (closed) return
          if (uri) {
            misses = 0
            delivered++
            emit(frames, { uri, at: now() })
          } else misses++
        } catch {
          misses++
        }
        if (misses >= 3) {
          emit(ended, undefined)
          return
        }
        const t = now()
        if (t - statAt >= 1000) {
          emit(stats, { fps: Math.round((delivered * 1000) / (t - statAt)), kbps: 0, quality: q })
          delivered = 0
          statAt = t
        }
        if (!closed) timer = setTimer(() => void tick(), interval())
      }
      // The first still is delivered right after the caller subscribes.
      timer = setTimer(() => {
        emit(frames, { uri: first, at: now() })
        timer = setTimer(() => void tick(), interval())
      }, 0)
      return {
        mode: 'stills',
        get quality() {
          return q
        },
        onFrame: listen(frames),
        onStats: listen(stats),
        onEnded: listen(ended),
        async setQuality(next) {
          q = next
        },
        close() {
          closed = true
          if (timer) clearTimer(timer)
          timer = null
        },
      }
    },
  }
}

/**
 * The feeds for whatever printer source is current: the paired computer's camera stream when its
 * connection offers one, stills otherwise. Re-resolved on every open, so a switch of source needs
 * no plumbing here.
 */
export function feedsFor(printers: Pick<SwitchablePrinters, 'snapshotUri'> & { camera?: () => PairedCamera | null }, rtc: RtcApi | null = loadWebRtc()): CameraFeeds {
  const stills = stillsFeeds((id) => printers.snapshotUri(id))
  return {
    async open(printerId, opts) {
      const camera = printers.camera?.() ?? null
      if (!camera) return stills.open(printerId, opts)
      // Away from home: direct video first, then sealed JPEG through the relay, then stills.
      const remote = (await camera.remote?.().catch(() => false)) === true
      if (remote && rtc && camera.rtc) {
        try {
          return await rtcFeeds(camera, rtc).open(printerId, opts)
        } catch {
          // No direct path, or the hub has no direct video: the sealed JPEG stream is next.
        }
      }
      // A stream that the host refuses (not_supported) still has stills behind it.
      try {
        return await pairedFeeds(camera, remote ? { capMs: RELAY_MAX_MS } : {}).open(printerId, opts)
      } catch {
        return stills.open(printerId, opts)
      }
    },
  }
}
