// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the camera player needs from a printer connector: a live stream at a chosen quality, and which
// way it travels. Connectors will provide real streams (RTSP or MJPEG relayed to WebRTC, direct on the
// LAN and through the relay away from home); until then a generated test stream stands in, and
// snapshots stay as the fallback when a printer offers no stream.
import type { Host, PrinterInfo } from '@slicerx/contracts'

/** Quality levels from lightest to best. A camera supports some prefix of these. */
export const QUALITIES = ['low', 'medium', 'high'] as const
export type Quality = (typeof QUALITIES)[number]

/** What each level asks the camera for, for the stub and for connectors to map onto their own encoders. */
export const QUALITY_SPEC: Record<Quality, { width: number; height: number; fps: number }> = {
  low: { width: 640, height: 360, fps: 10 },
  medium: { width: 1280, height: 720, fps: 15 },
  high: { width: 1920, height: 1080, fps: 30 },
}

export interface StreamStats {
  /** Frames per second reaching the player. */
  fps: number
  /** Delay from the camera to the screen. */
  latencyMs: number
  /** Incoming bitrate. */
  kbps: number
}

/**
 * What a live session's camera is doing. `retrying`: the camera dropped the connection or stopped,
 * and the bridge tries it again in `retryInMs` (try `attempt`) for as long as the view is open.
 * `live`: the camera is open. `failed`: it will not open by waiting (`reason`).
 */
export interface CameraStatus {
  state: 'live' | 'retrying' | 'failed'
  attempt?: number
  retryInMs?: number
  reason?: string
}

export interface CameraSession {
  /** The live video. Null in snapshot mode. */
  media: MediaStream | null
  mode: 'live' | 'snapshot'
  /** Direct on the local network, or through the SlicerX relay. */
  route: 'lan' | 'relay'
  /** Levels the camera can produce, lightest first. */
  supported: readonly Quality[]
  quality: Quality
  setQuality(q: Quality): Promise<void>
  /** Called about once a second with what the connection is doing. */
  onStats(cb: (s: StreamStats) => void): () => void
  /** Why a live session shows no picture, in one plain line; an empty line once a picture shows. */
  onProblem?(cb: (text: string) => void): () => void
  /** The camera feed's state now, then each change (see `CameraStatus`). */
  onStatus?(cb: (s: CameraStatus) => void): () => void
  /** Latest still, in snapshot mode. */
  snapshot?(): Promise<Blob | null>
  /** `reason`, in plain words, goes to the bridge's connection log. */
  close(reason?: string): void
}

export interface CameraStreams {
  open(printer: Pick<PrinterInfo, 'id' | 'name'>, opts: { quality: Quality; signal?: AbortSignal }): Promise<CameraSession>
}

/** The connector-provided streams when the host has them, else the stand-in. */
export function cameraStreams(host: Host): CameraStreams {
  const provided = (host.printers as (Host['printers'] & { streams?: CameraStreams }) | undefined)?.streams
  return provided ?? stubStreams(host)
}

/** A generated moving test card, so the player, quality steps and fullscreen work before real streams arrive. Marked as a stand-in on screen. */
export function stubStreams(host?: Host): CameraStreams {
  return {
    async open(printer, { quality }) {
      const canvas = document.createElement('canvas')
      const capture = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream
      if (typeof capture !== 'function') return snapshotSession(host, printer)
      let q: Quality = quality
      let timer = 0
      let frames = 0
      const listeners = new Set<(s: StreamStats) => void>()
      let media: MediaStream
      const draw = (t: number) => {
        const spec = QUALITY_SPEC[q]
        if (canvas.width !== spec.width) {
          canvas.width = spec.width
          canvas.height = spec.height
        }
        const g = canvas.getContext('2d')
        if (!g) return
        g.fillStyle = '#1b1c26'
        g.fillRect(0, 0, canvas.width, canvas.height)
        g.strokeStyle = '#bd93f9'
        g.lineWidth = Math.max(2, canvas.height / 120)
        const x = ((t / 40) % canvas.width) | 0
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(canvas.width - x, canvas.height)
        g.stroke()
        g.fillStyle = '#f8f8f2'
        g.font = `${Math.round(canvas.height / 18)}px sans-serif`
        g.fillText(`${printer.name}: test stream, ${q}`, 16, canvas.height / 10)
        frames++
      }
      const start = () => {
        window.clearInterval(timer)
        timer = window.setInterval(() => draw(performance.now()), 1000 / QUALITY_SPEC[q].fps)
      }
      draw(0)
      media = capture.call(canvas, 30)
      start()
      const statTimer = window.setInterval(() => {
        const spec = QUALITY_SPEC[q]
        const s: StreamStats = { fps: frames, latencyMs: 40, kbps: Math.round((spec.width * spec.height * frames) / 1000 / 8) }
        frames = 0
        for (const l of listeners) l(s)
      }, 1000)
      return {
        media,
        mode: 'live',
        route: 'lan',
        supported: QUALITIES,
        get quality() {
          return q
        },
        async setQuality(next) {
          q = next
          start()
        },
        onStats(cb) {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
        close() {
          window.clearInterval(timer)
          window.clearInterval(statTimer)
          for (const t of media.getTracks()) t.stop()
          listeners.clear()
        },
      }
    },
  }
}

/** Stills from the connector's snapshot call, about every two seconds, for a printer with no live stream. */
export function snapshotSession(host: Host | undefined, printer: Pick<PrinterInfo, 'id' | 'name'>): CameraSession {
  return {
    media: null,
    mode: 'snapshot',
    route: 'lan',
    supported: ['low'],
    quality: 'low',
    async setQuality() {},
    onStats: () => () => undefined,
    snapshot: () => (host?.printers ? host.printers.snapshot(printer.id).catch(() => null) : Promise.resolve(null)),
    close() {},
  }
}
