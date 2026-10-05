// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PairCameraHandle, PairCameraSource } from '../src/camera-relay'
import type { PairPushHub } from '../src/host'
import { createPairedPrinterHost } from '../src/printer-host'
import { flush, pairByLink, world } from './helpers'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xfb, 0xff, 0xd9])

/** A camera source the test drives frame by frame. */
function fakeCamera() {
  const opened: { printerId: string; quality?: string; closed: boolean }[] = []
  let frame: ((f: Parameters<Parameters<PairCameraHandle['onFrame']>[0]>[0]) => void) | null = null
  let stats: ((s: { fps: number; kbps: number; dropped: number; quality: 'low' | 'medium' | 'high' }) => void) | null = null
  let ended: (() => void) | null = null
  const source: PairCameraSource = {
    async open(printerId, o) {
      if (printerId === 'no-cam') throw Object.assign(new Error('none'), { code: 'not_supported' })
      const rec = { printerId, ...(o.quality ? { quality: o.quality } : {}), closed: false }
      opened.push(rec)
      return {
        quality: 'high',
        onFrame: (cb) => ((frame = cb), () => (frame = null)),
        onStats: (cb) => ((stats = cb), () => (stats = null)),
        onEnded: (cb) => ((ended = cb), () => (ended = null)),
        setQuality: async () => undefined,
        close: async () => void (rec.closed = true),
      }
    },
    grab: async (printerId) => (printerId === 'bay-2' ? { contentType: 'image/jpeg', data: JPEG, capturedAt: '2026-10-01T12:00:00.000Z', source: 'snapshot' } : null),
  }
  return {
    source,
    opened,
    frame: (kind: 'jpeg' | 'h264' = 'jpeg') => frame?.({ kind, key: true, capturedAt: 1000, data: JPEG }),
    stats: (fps: number) => stats?.({ fps, kbps: 400, dropped: 1, quality: 'high' }),
    end: () => ended?.(),
  }
}

function fakePush() {
  const calls: unknown[] = []
  const hub: PairPushHub = {
    register: async (r) => void calls.push(['register', r]),
    unregister: async (by) => void calls.push(['unregister', by]),
  }
  return { hub, calls }
}

async function setup() {
  const cam = fakeCamera()
  const push = fakePush()
  const w = await world({ services: { camera: cam.source, push: push.hub } })
  const phone = w.phone('Pocket')
  await pairByLink(w, phone)
  const pairingId = (await phone.client.hosts())[0]?.pairingId ?? ''
  const conn = await phone.client.connect(pairingId)
  return { w, cam, push, conn, pairingId }
}

describe('camera and push on the paired channel', () => {
  it('relays JPEG frames as standard base64, capped to the phone frame rate', async () => {
    const { w, cam, conn } = await setup()
    expect(conn.info.camera).toBe(true)
    const frames: { stream: number; dataB64: string }[] = []
    const stats: { fps: number; dropped: number }[] = []
    conn.camera.onFrame((f) => frames.push(f))
    conn.camera.onStats((s) => stats.push(s))
    const opened = await conn.camera.open('bay-2', { quality: 'auto' })
    expect(opened).toEqual({ stream: 1, quality: 'high' })
    expect(cam.opened[0]).toMatchObject({ printerId: 'bay-2', quality: 'auto' })
    cam.frame()
    cam.frame() // same instant: over the 10 fps cap, dropped
    w.env.advance(100)
    cam.frame()
    cam.stats(25)
    await flush()
    expect(frames).toHaveLength(2)
    expect(frames[0]?.dataB64).toBe(btoa(String.fromCharCode(...JPEG)))
    expect(stats[0]).toMatchObject({ fps: 10, dropped: 1 })
    await conn.camera.close(1)
    expect(cam.opened[0]?.closed).toBe(true)
  })

  it('ends an H.264 stream with reason codec and refuses a printer without a camera', async () => {
    const { cam, conn } = await setup()
    const ended: unknown[] = []
    conn.camera.onEnded((e) => ended.push(e))
    await conn.camera.open('bay-2', { quality: 'low' })
    cam.frame('h264')
    await flush()
    expect(ended).toEqual([{ stream: 1, reason: 'codec' }])
    expect(cam.opened[0]?.closed).toBe(true)
    await expect(conn.camera.open('no-cam', { quality: 'low' })).rejects.toMatchObject({ code: 'not_supported' })
  })

  it('closes streams when the phone disconnects and limits streams per session', async () => {
    const { w, cam, conn } = await setup()
    await conn.camera.open('bay-2', { quality: 'low' })
    await conn.camera.open('bay-3', { quality: 'low' })
    await expect(conn.camera.open('bay-1', { quality: 'low' })).rejects.toMatchObject({ code: 'busy' })
    conn.close()
    await flush()
    w.env.advance(1)
    await flush()
    expect(cam.opened.every((o) => o.closed)).toBe(true)
  })

  it('grabs one still', async () => {
    const { conn } = await setup()
    const still = await conn.grab('bay-2')
    expect(still).toEqual({ contentType: 'image/jpeg', dataB64: btoa(String.fromCharCode(...JPEG)), capturedAt: Date.parse('2026-10-01T12:00:00.000Z'), source: 'snapshot' })
    expect(await conn.grab('bay-1')).toBeNull()
  })

  it('registers push tokens under the pairing and removes them on revoke', async () => {
    const { w, push, conn, pairingId } = await setup()
    expect(conn.info.push).toBe(true)
    const prefs = { printDone: true, printFailed: true, attention: false, approvals: true }
    await expect(conn.push.register({ token: 'not-a-token', platform: 'ios', prefs })).rejects.toMatchObject({ code: 'bad_request' })
    await conn.push.register({ token: 'ExponentPushToken[abcdefghijklmnop]', platform: 'ios', prefs })
    expect(push.calls).toEqual([['register', { token: 'ExponentPushToken[abcdefghijklmnop]', platform: 'ios', prefs, tag: pairingId }]])
    await w.host.revoke(pairingId)
    await flush()
    expect(push.calls.at(-1)).toEqual(['unregister', { tag: pairingId }])
  })

  it('exposes camera and push on the paired PrinterHost only when the computer offers them', async () => {
    const { conn } = await setup()
    const printers = createPairedPrinterHost({ connection: async () => conn, local: { verify: async () => ({ ok: true }) } as never })
    expect(await printers.camera()).toBe(conn.camera)
    expect(await printers.push()).toBe(conn.push)
    const bare = await world()
    const phone = bare.phone('Other')
    await pairByLink(bare, phone)
    const c2 = await phone.client.connect((await phone.client.hosts())[0]?.pairingId ?? '')
    const p2 = createPairedPrinterHost({ connection: async () => c2, local: { verify: async () => ({ ok: true }) } as never })
    expect(await p2.camera()).toBeNull()
    expect(await p2.push()).toBeNull()
  })
})
