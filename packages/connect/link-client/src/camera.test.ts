// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The camera client against the real sx-link binary and the camera mocks. The canvas renderer needs a
// browser, so these tests use a recording renderer; avcCodecString is checked on its own.
import assert from 'node:assert/strict'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { startMocks, type RunningMocks } from '@slicerx/mock-printers'
import { avcCodecString, connectLink, LinkError, linkCameraStreams, type CameraFrame, type LinkHost, type Renderer } from './index.ts'

// Runs only when SX_LINK_BIN names a built sx-link (cargo build -p sx-link), with a throwaway state
// directory and file secrets, so a test never touches the real hub state or the keychain.
const bin = process.env['SX_LINK_BIN'] ?? ''
const skip = bin && existsSync(bin) ? false : 'set SX_LINK_BIN to a built sx-link to run'
const dir = skip ? '' : mkdtempSync(join(tmpdir(), 'sx-link-test-'))

let proc: ChildProcessByStdio<null, Readable, Readable>
let mocks: RunningMocks
let host: LinkHost

before(async () => {
  if (skip) return
  mocks = await startMocks({ only: ['moonraker', 'prusalink', 'rtsp-camera'], state: 'idle', camera: false })
  proc = spawn(bin, ['--port', '0', '--state-dir', dir, '--secrets', 'file', '--no-mdns', ...(process.env['SX_TEST_LAN'] === '1' ? [] : ['--loopback'])], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const [url, code] = await new Promise<[string, string]>((resolve, reject) => {
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
      const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
      if (u && c) resolve([u[0], c[1] ?? ''])
    })
    proc.once('exit', () => reject(new Error('sx-link exited early')))
  })
  host = await connectLink({ url, code })
  await host.addPrinter({ id: 'voron', name: 'Voron', plugin: 'moonraker', host: '127.0.0.1', port: mocks.ports.moonraker ?? 0 })
  await host.addPrinter({ id: 'mk4', name: 'MK4S', plugin: 'prusalink', host: '127.0.0.1', port: mocks.ports.prusalink ?? 0 })
  // A camera that is not the printer's own. The mock without a login keeps the OS keychain out of the test.
  await host.addPrinter({ id: 'ipcam', name: 'IP camera', plugin: 'moonraker', host: '127.0.0.1', cameraUrl: `rtsp://127.0.0.1:${mocks.ports['rtsp-open'] ?? 0}/live` })
})

after(async () => {
  host?.close()
  proc?.kill()
  if (dir) rmSync(dir, { recursive: true, force: true })
  await mocks?.stop()
})

const until = async (ok: () => boolean, ms = 6000) => {
  for (let t = 0; t < ms && !ok(); t += 25) await new Promise((r) => setTimeout(r, 25))
  assert.ok(ok(), 'timed out')
}

class Recorder implements Renderer {
  frames: CameraFrame[] = []
  closed = false
  media = null
  draw(f: CameraFrame) {
    this.frames.push(f)
  }
  close() {
    this.closed = true
  }
}

test('avcCodecString reads the profile, constraints and level from the SPS', () => {
  assert.equal(avcCodecString(new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, 0x95, 0xa8])), 'avc1.42001f')
  assert.equal(avcCodecString(new Uint8Array([0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac])), 'avc1.640028')
  assert.equal(avcCodecString(new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3, 4, 5, 6, 7])), undefined)
  assert.equal(avcCodecString(new Uint8Array()), undefined)
})

test('JPEG frames arrive with their header fields, stats follow, quality changes and close stops it', { skip }, async () => {
  const cam = await host.camera.open('voron', { quality: 'medium' })
  assert.equal(cam.quality, 'medium')
  const frames: CameraFrame[] = []
  const stats: { fps: number; quality: string }[] = []
  cam.onFrame((f) => frames.push(f))
  cam.onStats((s) => stats.push(s))
  await until(() => frames.length >= 3)
  for (const f of frames) {
    assert.equal(f.kind, 'jpeg')
    assert.equal(f.key, true)
    assert.equal(f.stream, cam.stream)
    assert.deepEqual([...f.data.subarray(0, 2)], [0xff, 0xd8])
    assert.ok(Math.abs(Date.now() - f.capturedAt) < 5000)
  }
  await until(() => stats.length > 0)
  assert.ok((stats[0]?.fps ?? 0) > 0)
  await cam.setQuality('low')
  await cam.close()
  await new Promise((r) => setTimeout(r, 300))
  const n = frames.length
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(frames.length, n, 'no frames after close')
})

test('H.264 from an RTSP camera arrives as Annex B with the parameter sets on the first key frame', { skip }, async () => {
  const cam = await host.camera.open('ipcam')
  const frames: CameraFrame[] = []
  cam.onFrame((f) => frames.push(f))
  await until(() => frames.length >= 4)
  assert.equal(frames[0]?.kind, 'h264')
  assert.equal(frames[0]?.key, true)
  assert.equal(avcCodecString(frames[0]?.data ?? new Uint8Array()), 'avc1.42001f')
  await cam.close()
})

test('a printer with no camera rejects with not_supported and an unknown one with not_found', { skip }, async () => {
  await assert.rejects(host.camera.open('mk4'), (e: unknown) => e instanceof LinkError && e.code === 'not_supported')
  await assert.rejects(host.camera.open('nope'), (e: unknown) => e instanceof LinkError && e.code === 'not_found')
})

test('probe reports the source before anything streams', { skip }, async () => {
  const p = await host.camera.probe('voron', 700)
  assert.equal(p.ok, true)
  assert.equal(p.kind, 'jpeg')
  assert.ok(p.fps > 3)
  assert.equal(p.recommended, 'high')
})

test('the player session draws frames, reports stats and follows quality', { skip }, async () => {
  const rec = new Recorder()
  const streams = linkCameraStreams(host, { renderer: () => rec })
  const session = await streams.open({ id: 'voron', name: 'Voron' }, { quality: 'high' })
  assert.equal(session.mode, 'live')
  assert.equal(session.route, 'lan')
  assert.deepEqual([...session.supported], ['low', 'medium', 'high'])
  const stats: { fps: number; latencyMs: number }[] = []
  session.onStats((s) => stats.push(s))
  await until(() => rec.frames.length >= 3 && stats.length > 0)
  assert.ok((stats[0]?.latencyMs ?? -1) >= 0)
  await session.setQuality('low')
  assert.equal(session.quality, 'low')
  session.close()
  assert.equal(rec.closed, true)
})

test('opening can be canceled, and a printer without a camera lets the player fall back', { skip }, async () => {
  const streams = linkCameraStreams(host, { renderer: () => new Recorder() })
  const ctl = new AbortController()
  ctl.abort()
  await assert.rejects(streams.open({ id: 'voron', name: 'Voron' }, { quality: 'high', signal: ctl.signal }), { name: 'AbortError' })
  await assert.rejects(streams.open({ id: 'mk4', name: 'MK4S' }, { quality: 'high' }), (e: unknown) => e instanceof LinkError && e.code === 'not_supported')
})

// A peer that behaves like a browser's for what openWebRtc uses: it gathers, takes the answer, and
// then connects (or fails, when told to) and delivers one video track.
class FakePeer extends EventTarget {
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: { sdp: string } | null = null
  closed = false
  offer = ''
  outcome: 'connect' | 'fail' | 'silent'
  constructor(outcome: 'connect' | 'fail' | 'silent') {
    super()
    this.outcome = outcome
  }
  addTransceiver() {}
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d
    this.offer = d.sdp
  }
  async setRemoteDescription(d: { sdp: string }) {
    assert.ok(d.sdp.startsWith('v=0'))
    setTimeout(() => {
      this.connectionState = this.outcome === 'fail' ? 'failed' : 'connected'
      this.dispatchEvent(new Event('connectionstatechange'))
      if (this.outcome === 'connect') {
        const ev = Object.assign(new Event('track'), { streams: [{ id: 'cam' }], track: {} })
        this.dispatchEvent(ev)
      }
    }, 10)
  }
  async getStats() {
    return new Map<string, unknown>([['a', { type: 'inbound-rtp', kind: 'video', framesPerSecond: 15, bytesReceived: 1000 }]])
  }
  close() {
    this.closed = true
  }
}

test('WebRTC: the offer goes through the bridge to the camera service and media comes back on the peer', { skip }, async () => {
  const peer = new FakePeer('connect')
  const streams = linkCameraStreams(host, { renderer: () => new Recorder(), webrtc: { createPeer: () => peer as unknown as RTCPeerConnection } })
  const session = await streams.open({ id: 'voron', name: 'Voron' }, { quality: 'high' })
  assert.deepEqual((session.media as unknown as { id: string }).id, 'cam')
  assert.deepEqual([...session.supported], ['high'])
  assert.equal(session.route, 'lan')
  session.close()
  assert.equal(peer.closed, true)
})

test('WebRTC falls back to bridge frames when the printer has no WebRTC service, or the connection fails', { skip }, async () => {
  // The IP camera is an RTSP camera, not a WebRTC one: signaling is unsupported, frames take over.
  const rec = new Recorder()
  const peer = new FakePeer('connect')
  const streams = linkCameraStreams(host, { renderer: () => rec, webrtc: { createPeer: () => peer as unknown as RTCPeerConnection } })
  const session = await streams.open({ id: 'ipcam', name: 'IP camera' }, { quality: 'high' })
  assert.equal(peer.closed, true, 'the failed WebRTC attempt was closed')
  await until(() => rec.frames.length >= 2)
  assert.equal(rec.frames[0]?.kind, 'h264')
  session.close()

  // ICE fails on a printer that does answer: the peer is closed and frames are used.
  const bad = new FakePeer('fail')
  const rec2 = new Recorder()
  const s2 = await linkCameraStreams(host, { renderer: () => rec2, webrtc: { createPeer: () => bad as unknown as RTCPeerConnection } }).open({ id: 'voron', name: 'Voron' }, { quality: 'high' })
  assert.equal(bad.closed, true)
  await until(() => rec2.frames.length >= 2)
  assert.equal(rec2.frames[0]?.kind, 'jpeg')
  s2.close()
})

test('camera discovery returns well formed ONVIF suggestions', { skip }, async () => {
  // The bridge sends a real multicast probe here, so the answer depends on the network; the shape does not.
  const found = await host.camera.discover(300)
  assert.ok(Array.isArray(found))
  for (const c of found) assert.match(c.cameraUrl, /^onvif:\/\//)
})

// A live view with no picture says why: the renderer's own reason (a codec this machine cannot
// decode), and the camera stopping. No bridge needed: the camera calls are faked.
test('a live view says in one line why there is no picture', async () => {
  let ended: (() => void) | undefined
  let closedWith: string | undefined
  let setStatus: ((s: { state: 'live' | 'retrying' | 'failed'; retryInMs?: number; reason?: string }) => void) | undefined
  const handle = {
    stream: 1,
    quality: 'high' as const,
    onFrame: () => () => undefined,
    onStats: () => () => undefined,
    onEnded: (cb: () => void) => {
      ended = cb
      return () => undefined
    },
    onStatus: (cb: (s: { state: 'live' | 'retrying' | 'failed'; retryInMs?: number; reason?: string }) => void) => {
      setStatus = cb
      return () => undefined
    },
    setQuality: async () => undefined,
    close: async (reason?: string) => {
      closedWith = reason
    },
  }
  const camera = {
    probe: async () => ({ ok: true, firstFrameMs: 100, fps: 15, kbps: 900, recommended: 'high' as const }),
    open: async () => handle,
  } as unknown as LinkHost['camera']
  let tell: ((text: string) => void) | undefined
  const renderer: Renderer = {
    media: null,
    draw: () => undefined,
    onProblem: (cb) => {
      tell = cb
      return () => undefined
    },
    close: () => undefined,
  }
  const s = await linkCameraStreams({ camera }, { webrtc: false, renderer: () => renderer }).open({ id: 'h2d', name: 'H2D' }, { quality: 'high' })
  const said: string[] = []
  s.onProblem?.((t) => said.push(t))
  tell?.("This computer cannot decode the camera's video (H.264, avc1.640028).")
  tell?.('')
  // The bridge tries a camera that dropped the connection again, and says when it is back.
  const states: string[] = []
  s.onStatus?.((st) => states.push(st.state))
  setStatus?.({ state: 'retrying', retryInMs: 5000 })
  setStatus?.({ state: 'live' })
  // A camera that will not open by waiting: its reason, and no "stopped" line after it.
  setStatus?.({ state: 'failed', reason: 'The printer refused the camera login. Check the access code.' })
  assert.deepEqual(states, ['live', 'retrying', 'live', 'failed'])
  ended?.()
  assert.deepEqual(said, ["This computer cannot decode the camera's video (H.264, avc1.640028).", '', 'The camera connection dropped. Trying again in 5 s.', '', 'The printer refused the camera login. Check the access code.'])
  // The reason a view gives for closing reaches the bridge, for its connection log.
  s.close('the view closed or the app navigated away')
  assert.equal(closedWith, 'the view closed or the app navigated away')
})
