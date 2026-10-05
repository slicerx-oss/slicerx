// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The host side of live camera video for paired phones. The computer's camera source (sx-link's
// camera.* through @slicerx/link-client) hands over JPEG frames; this module forwards them to one
// phone session as `camera.frame` events, capped to a frame rate the phone link can carry, and
// passes on stats and the end of the stream. H.264 cannot be drawn on the phone without a decoder,
// so a stream that turns out to be H.264 ends with reason `codec` and the phone falls back to stills.
import { toB64 } from './bytes'
import { MAX_FRAME_B64, PairError, type CameraQuality, type RpcPeer } from './rpc'

export type CameraQualityChoice = CameraQuality | 'auto'

/** One live stream from the computer's camera source. `LinkCamera.open` from @slicerx/link-client fits. */
export interface PairCameraHandle {
  readonly quality: CameraQuality
  onFrame(cb: (f: { kind: 'jpeg' | 'h264'; key: boolean; capturedAt: number; data: Uint8Array }) => void): () => void
  onStats(cb: (s: { fps: number; kbps: number; dropped: number; quality: CameraQuality }) => void): () => void
  onEnded(cb: () => void): () => void
  setQuality(q: CameraQualityChoice): Promise<void>
  close(): Promise<void>
}

/** What the app supplies. `LinkHost.camera` from @slicerx/link-client fits. */
export interface PairCameraSource {
  /** `jpegOnly`: the hub turns H.264 key frames into JPEG, since phones draw JPEG only. */
  open(printerId: string, opts: { quality?: CameraQualityChoice; jpegOnly?: boolean }): Promise<PairCameraHandle>
  /** One still. `capturedAt` is ms since the epoch or an ISO string. */
  grab?(printerId: string): Promise<{ contentType: string; data: Uint8Array; capturedAt: string | number; source: 'snapshot' | 'stream' } | null>
}

/** Frames per second sent to a phone at each quality. The relay path is the slow one. */
export const PHONE_FPS: Record<CameraQuality, number> = { low: 2, medium: 5, high: 10 }

interface Relayed {
  handle: PairCameraHandle
  quality: CameraQuality
  offs: (() => void)[]
}

/** Camera streams for one phone session. */
export interface CameraRelay {
  open(printerId: string, quality: CameraQualityChoice | undefined): Promise<{ stream: number; quality: CameraQuality }>
  setQuality(stream: number, quality: CameraQuality): Promise<{ quality: CameraQuality }>
  close(stream: number): Promise<void>
  /** Ends every stream; the session is going away. */
  closeAll(): void
}

export function createCameraRelay(source: PairCameraSource, rpc: RpcPeer, opts: { maxStreams: number; now: () => number }): CameraRelay {
  const streams = new Map<number, Relayed>()
  let next = 1

  const end = (id: number, reason: 'ended' | 'codec' | 'closed', tell: boolean) => {
    const r = streams.get(id)
    if (!r) return
    streams.delete(id)
    for (const off of r.offs) off()
    void r.handle.close().catch(() => undefined)
    if (tell) rpc.emit('camera.ended', { stream: id, reason })
  }

  return {
    async open(printerId, quality) {
      if (streams.size >= opts.maxStreams) throw new PairError('busy', 'Too many camera streams open')
      let handle: PairCameraHandle
      try {
        handle = await source.open(printerId, { quality: quality ?? 'auto', jpegOnly: true })
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === 'not_supported') throw new PairError('not_supported', 'This printer has no live camera')
        if (code === 'not_found') throw new PairError('not_found', 'No such printer')
        throw new PairError('unavailable', 'The camera did not answer')
      }
      const id = next++
      const r: Relayed = { handle, quality: handle.quality, offs: [] }
      streams.set(id, r)
      let lastSent = 0
      let dropped = 0
      r.offs.push(
        handle.onFrame((f) => {
          if (f.kind !== 'jpeg') return end(id, 'codec', true)
          const t = opts.now()
          if (t - lastSent < 1000 / PHONE_FPS[r.quality]) return
          const dataB64 = toB64(f.data)
          if (dataB64.length > MAX_FRAME_B64) {
            dropped++
            return
          }
          lastSent = t
          rpc.emit('camera.frame', { stream: id, capturedAt: f.capturedAt, key: f.key, kind: 'jpeg', dataB64 })
        }),
        handle.onStats((s) => {
          r.quality = s.quality
          rpc.emit('camera.stats', { stream: id, fps: Math.min(s.fps, PHONE_FPS[s.quality]), kbps: s.kbps, dropped: s.dropped + dropped, quality: s.quality })
          dropped = 0
        }),
        handle.onEnded(() => end(id, 'ended', true)),
      )
      return { stream: id, quality: handle.quality }
    },
    async setQuality(stream, quality) {
      const r = streams.get(stream)
      if (!r) throw new PairError('not_found', 'No such camera stream')
      await r.handle.setQuality(quality)
      r.quality = quality
      return { quality }
    },
    async close(stream) {
      end(stream, 'closed', false)
    },
    closeAll() {
      for (const id of [...streams.keys()]) end(id, 'closed', false)
    },
  }
}
