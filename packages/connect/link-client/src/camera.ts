// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Live printer video for the camera player. `linkCameraStreams` opens a stream through sx-link and
// turns its frames into a MediaStream: JPEG frames are decoded with createImageBitmap and H.264
// with WebCodecs, both drawn on a canvas that `captureStream` publishes. The shapes below match
// `CameraStreams` in packages/app/src/camera/stream.ts, so a host can hand this straight to the player.
import type { CameraFrame, CameraHandle, CameraProbe, CameraStatus, LinkCamera } from './index.ts'

export type Quality = 'low' | 'medium' | 'high'
export const QUALITIES: readonly Quality[] = ['low', 'medium', 'high']

export interface StreamStats {
  /** Frames per second reaching the player. */
  fps: number
  /** Delay from the bridge receiving a frame to the player getting it. Not glass to glass. */
  latencyMs: number
  kbps: number
}

export interface CameraSession {
  media: MediaStream | null
  mode: 'live' | 'snapshot'
  /** `lan`: this client talks to sx-link directly. A relay route needs the SlicerX relay, which is not built yet. */
  route: 'lan' | 'relay'
  supported: readonly Quality[]
  readonly quality: Quality
  setQuality(q: Quality): Promise<void>
  onStats(cb: (s: StreamStats) => void): () => void
  /** Why there is no picture, in one plain line, when there is none; an empty line once a picture shows. */
  onProblem?(cb: (text: string) => void): () => void
  /** The camera feed's state now, then each change: `retrying` while the bridge tries the camera again. */
  onStatus?(cb: (s: CameraStatus) => void): () => void
  snapshot?(): Promise<Blob | null>
  /** `reason`, in plain words, goes to the bridge's connection log. */
  close(reason?: string): void
}

export interface CameraStreams {
  open(printer: { id: string; name: string }, opts: { quality: Quality; signal?: AbortSignal }): Promise<CameraSession>
}

/** Where frames go. The browser implementation draws on a canvas; tests use a recorder. */
export interface Renderer {
  readonly media: MediaStream | null
  draw(frame: CameraFrame): void
  /** Called with a plain line when frames arrive but cannot be shown, and with '' once one is drawn. */
  onProblem?(cb: (text: string) => void): () => void
  close(): void
}

/** How long a live view waits for its first picture before it says there is none. */
export const FIRST_PICTURE_MS = 10_000

/** The RFC 6381 codec string (`avc1.42001f`) from the first SPS in an Annex B access unit. */
export function avcCodecString(annexB: Uint8Array): string | undefined {
  for (let i = 0; i + 7 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && (annexB[i + 2] === 1 || (annexB[i + 2] === 0 && annexB[i + 3] === 1))) {
      const at = i + (annexB[i + 2] === 1 ? 3 : 4)
      if (((annexB[at] ?? 0) & 0x1f) === 7 && at + 3 < annexB.length) {
        const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, '0')
        return `avc1.${hex(annexB[at + 1])}${hex(annexB[at + 2])}${hex(annexB[at + 3])}`
      }
    }
  }
  return undefined
}

/** Draws frames on a canvas and publishes it as a MediaStream. Browsers only. */
export function createCanvasRenderer(): Renderer {
  const canvas = document.createElement('canvas')
  const media = canvas.captureStream(30)
  const ctx = canvas.getContext('2d')
  let closed = false
  const problems = new Set<(text: string) => void>()
  let shown = false
  let said = ''
  const say = (text: string) => {
    if (text === said) return
    said = text
    for (const cb of problems) cb(text)
  }
  const drawn = () => {
    if (shown) return
    shown = true
    say('')
  }

  // JPEG: decode the newest frame only. A frame that arrives while one is decoding replaces the queued one.
  let busy = false
  let pending: Uint8Array | null = null
  const drawJpeg = async (data: Uint8Array) => {
    busy = true
    try {
      const bmp = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }))
      if (!closed && ctx) {
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width
          canvas.height = bmp.height
        }
        ctx.drawImage(bmp, 0, 0)
        drawn()
      }
      bmp.close()
    } catch {
      // A bad frame is skipped.
    } finally {
      busy = false
      const next = pending
      pending = null
      if (next && !closed) void drawJpeg(next)
    }
  }

  // H.264 through WebCodecs. Decoding starts at a key frame and, if the decoder falls behind, restarts at the next one.
  let decoder: VideoDecoder | undefined
  let needKey = true
  let n = 0
  // Key frames seen with no SPS to start a decoder on, and decoder failures, so the viewer hears why.
  let bareKeys = 0
  let failures = 0
  let checked = ''
  const resetDecoder = () => {
    try {
      decoder?.close()
    } catch {
      // Already closed.
    }
    decoder = undefined
    needKey = true
  }
  const drawH264 = (f: CameraFrame) => {
    if (typeof VideoDecoder === 'undefined') return say('This app cannot decode the camera\'s H.264 video here.')
    if (!decoder) {
      if (!f.key) return
      const codec = avcCodecString(f.data)
      if (!codec) {
        if (++bareKeys >= 3) say('The camera\'s video does not say how it is encoded, so it cannot be shown.')
        return
      }
      const config = { codec, optimizeForLatency: true, avc: { format: 'annexb' } } as VideoDecoderConfig
      // Ask once per codec whether this machine decodes it, so an unsupported one is named, not silent.
      if (checked !== codec) {
        checked = codec
        void VideoDecoder.isConfigSupported(config).then(
          (r) => {
            if (!r.supported && !closed) say(`This computer cannot decode the camera's video (H.264, ${codec}).`)
          },
          () => undefined,
        )
      }
      decoder = new VideoDecoder({
        output: (vf) => {
          if (!closed && ctx) {
            if (canvas.width !== vf.displayWidth || canvas.height !== vf.displayHeight) {
              canvas.width = vf.displayWidth
              canvas.height = vf.displayHeight
            }
            ctx.drawImage(vf, 0, 0)
            drawn()
          }
          vf.close()
        },
        error: () => {
          resetDecoder()
          if (++failures >= 3 && !shown) say('The camera\'s video could not be decoded.')
        },
      })
      try {
        decoder.configure(config)
      } catch {
        resetDecoder()
        return say(`This computer cannot decode the camera's video (H.264, ${codec}).`)
      }
      needKey = false
    }
    if (needKey && !f.key) return
    if (decoder.decodeQueueSize > 6) {
      needKey = true
      if (!f.key) return
    }
    needKey = false
    decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: n++ * 1000, data: f.data as BufferSource }))
  }

  return {
    media,
    onProblem(cb) {
      problems.add(cb)
      if (said) cb(said)
      return () => void problems.delete(cb)
    },
    draw(f) {
      if (closed) return
      if (f.kind === 'jpeg') {
        if (busy) pending = f.data
        else void drawJpeg(f.data)
      } else drawH264(f)
    },
    close() {
      closed = true
      problems.clear()
      resetDecoder()
      for (const t of media.getTracks()) t.stop()
    },
  }
}

/** What WebRTC playback needs. Browsers have all of it; tests supply a fake peer. */
export interface WebRtcOptions {
  createPeer?: () => RTCPeerConnection
  /** Give up on gathering candidates or connecting after this long. Default 2000 and 6000. */
  gatherMs?: number
  connectMs?: number
}

interface WebRtcSession {
  media: MediaStream
  stats(cb: (s: StreamStats) => void): () => void
  close(): void
}

/**
 * Plays a printer camera over WebRTC. The offer goes through the bridge to the camera's own service
 * (crowsnest camera-streamer, mediamtx or go2rtc WHEP, the Creality K2), and the media then flows
 * straight between this browser and the camera. Resolves once the connection is up; rejects on
 * anything else, so the caller can fall back to bridge-relayed frames.
 */
export async function openWebRtc(host: { camera: LinkCamera }, printerId: string, o: WebRtcOptions = {}): Promise<WebRtcSession> {
  const pc = (o.createPeer ?? (() => new RTCPeerConnection({ iceServers: [] })))()
  const fail = (e: unknown): never => {
    pc.close()
    throw e
  }
  const media = new Promise<MediaStream>((resolve) => {
    pc.addEventListener('track', (ev) => {
      const t = ev as RTCTrackEvent
      resolve(t.streams[0] ?? new MediaStream([t.track]))
    })
  })
  media.catch(() => undefined)
  try {
    pc.addTransceiver('video', { direction: 'recvonly' })
    await pc.setLocalDescription(await pc.createOffer())
    // Camera services take one offer and give one answer, so wait until the candidates are in the offer.
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const done = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', done)
            resolve()
          }
        }
        pc.addEventListener('icegatheringstatechange', done)
        setTimeout(resolve, o.gatherMs ?? 2000)
      })
    }
    const offer = pc.localDescription?.sdp
    if (!offer) throw new Error('no offer')
    const answer = await host.camera.webrtc(printerId, offer)
    const connected = new Promise<void>((resolve, reject) => {
      const check = () => {
        if (pc.connectionState === 'connected') resolve()
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') reject(new Error('WebRTC connection failed'))
      }
      pc.addEventListener('connectionstatechange', check)
      setTimeout(() => reject(new Error('WebRTC connection timed out')), o.connectMs ?? 6000)
      check()
    })
    connected.catch(() => undefined)
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    await connected
    // A connection with no video track is no camera.
    const stream = await Promise.race([media, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no video track')), 2000))])
    return {
      media: stream,
      stats(cb) {
        let last = { bytes: 0, at: 0 }
        const t = setInterval(async () => {
          let fps = 0
          let bytes = 0
          let delayMs = 0
          let rtt = 0
          for (const r of (await pc.getStats()).values()) {
            const s = r as Record<string, number | string | undefined>
            if (s.type === 'inbound-rtp' && s.kind === 'video') {
              fps = Number(s.framesPerSecond ?? 0)
              bytes = Number(s.bytesReceived ?? 0)
              const emitted = Number(s.jitterBufferEmittedCount ?? 0)
              if (emitted > 0) delayMs = (Number(s.jitterBufferDelay ?? 0) / emitted) * 1000
            } else if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime !== undefined) rtt = Number(s.currentRoundTripTime) * 1000
          }
          const now = Date.now()
          const kbps = last.at ? Math.round(((bytes - last.bytes) * 8) / Math.max(1, now - last.at)) : 0
          last = { bytes, at: now }
          cb({ fps: Math.round(fps), kbps, latencyMs: Math.round(delayMs + rtt / 2) })
        }, 1000)
        return () => clearInterval(t)
      },
      close: () => pc.close(),
    }
  } catch (e) {
    return fail(e)
  }
}

export interface LinkStreamsOptions {
  /** `false` never tries WebRTC. Default: try it when the browser has it (or a peer factory is given). */
  webrtc?: boolean | WebRtcOptions
  /** Makes the renderer for a session. Defaults to the canvas renderer. */
  renderer?: () => Renderer
  /** Look at the camera before streaming and start no higher than it recommends. Default true. */
  probe?: boolean
}

const RANK: Record<Quality, number> = { low: 0, medium: 1, high: 2 }

/**
 * Camera streams over sx-link. `open` rejects with the bridge's `not_supported` error when the
 * printer has no stream, so the player can fall back to snapshots.
 */
export function linkCameraStreams(host: { camera: LinkCamera }, o: LinkStreamsOptions = {}): CameraStreams {
  return {
    async open(printer, { quality, signal }) {
      const aborted = () => new DOMException('Camera canceled', 'AbortError')
      if (signal?.aborted) throw aborted()
      // WebRTC first: best quality and lowest delay. Anything that goes wrong falls through to frames.
      const rtc = o.webrtc === false ? undefined : typeof o.webrtc === 'object' ? o.webrtc : typeof RTCPeerConnection === 'undefined' ? undefined : {}
      if (rtc) {
        try {
          const w = await openWebRtc(host, printer.id, rtc)
          if (signal?.aborted) {
            w.close()
            throw aborted()
          }
          const listeners = new Set<(s: StreamStats) => void>()
          const off = w.stats((s) => {
            for (const cb of listeners) cb(s)
          })
          return {
            media: w.media,
            mode: 'live',
            route: 'lan',
            // The sender adapts its bitrate to the path, so there is one level to offer.
            supported: ['high'],
            quality: 'high',
            async setQuality() {},
            onStats(cb) {
              listeners.add(cb)
              return () => void listeners.delete(cb)
            },
            close() {
              off()
              listeners.clear()
              w.close()
            },
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') throw e
        }
      }
      let start: Quality = quality
      if (o.probe !== false) {
        const p: CameraProbe = await host.camera.probe(printer.id, 800)
        if (p.ok && RANK[p.recommended] < RANK[start]) start = p.recommended
      }
      if (signal?.aborted) throw aborted()
      const handle: CameraHandle = await host.camera.open(printer.id, { quality: start })
      if (signal?.aborted) {
        await handle.close()
        throw aborted()
      }
      const renderer = (o.renderer ?? createCanvasRenderer)()
      let q: Quality = handle.quality
      let latency = 0
      const listeners = new Set<(s: StreamStats) => void>()
      // What stands between the stream and a picture, in one line: the renderer's own reason, the
      // camera stopping, or nothing drawn yet after FIRST_PICTURE_MS.
      const problems = new Set<(text: string) => void>()
      let problem = ''
      let pictured = false
      let ended = false
      const say = (text: string) => {
        if (text === problem) return
        problem = text
        for (const cb of problems) cb(text)
      }
      const offProblem = renderer.onProblem?.((text) => {
        if (text === '') pictured = true
        if (!ended) say(text)
      })
      // The bridge tries a camera that dropped the connection again; say so, and hold the "no picture"
      // line while it does.
      const statuses = new Set<(s: CameraStatus) => void>()
      let status: CameraStatus = { state: 'live' }
      const offStatus = handle.onStatus((s) => {
        status = s
        for (const cb of statuses) cb(s)
        if (ended) return
        if (s.state === 'failed') say(s.reason ?? 'The camera did not open.')
        else if (s.state === 'retrying') say(`The camera connection dropped. Trying again in ${Math.max(1, Math.round((s.retryInMs ?? 0) / 1000))} s.`)
        else if (problem.startsWith('The camera connection dropped')) say('')
      })
      const firstPicture = setTimeout(() => {
        if (!pictured && !problem && status.state !== 'retrying') say('No picture from the camera after 10 seconds.')
      }, FIRST_PICTURE_MS)
      const offFrame = handle.onFrame((f) => {
        const d = Math.max(0, Date.now() - f.capturedAt)
        latency = latency === 0 ? d : latency * 0.8 + d * 0.2
        // A renderer that cannot say when it drew counts a frame as a picture.
        if (!renderer.onProblem) pictured = true
        renderer.draw(f)
      })
      const offStats = handle.onStats((s) => {
        q = s.quality
        for (const cb of listeners) cb({ fps: s.fps, kbps: s.kbps, latencyMs: Math.round(latency) })
      })
      const offEnded = handle.onEnded(() => {
        ended = true
        for (const cb of listeners) cb({ fps: 0, kbps: 0, latencyMs: 0 })
        // A failed feed already said why.
        if (status.state !== 'failed') say('The camera stopped sending video.')
      })
      return {
        media: renderer.media,
        mode: 'live',
        route: 'lan',
        supported: QUALITIES,
        get quality() {
          return q
        },
        async setQuality(next) {
          await handle.setQuality(next)
          q = next
        },
        onStats(cb) {
          listeners.add(cb)
          return () => void listeners.delete(cb)
        },
        onProblem(cb) {
          problems.add(cb)
          if (problem) cb(problem)
          return () => void problems.delete(cb)
        },
        onStatus(cb) {
          statuses.add(cb)
          cb(status)
          return () => void statuses.delete(cb)
        },
        close(reason) {
          clearTimeout(firstPicture)
          offStatus()
          statuses.clear()
          offProblem?.()
          problems.clear()
          offFrame()
          offStats()
          offEnded()
          listeners.clear()
          renderer.close()
          void handle.close(reason)
        },
      }
    },
  }
}
