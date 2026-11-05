// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A partner route's byte channel inside a pair session, as the bridge seals it (sx-link pair_session.rs, Channel::route):
// the same key as the bridge for the pinned vector, bytes both ways, and nothing sealed for the session or another
// route opening on it.
import { describe, expect, it } from 'vitest'
import { createChannel, routeKey } from '../src/session'

const SID = 'AAAAAAAAAAAAAAAAAAAAAA'
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

function pair() {
  const toHost = new Uint8Array(32).fill(1)
  const toDevice = new Uint8Array(32).fill(2)
  const device = createChannel(SID, { sendKey: toHost, recvKey: toDevice, sendDir: 3, recvDir: 4 }, () => undefined)
  const sentByHost: string[] = []
  const host = createChannel(SID, { sendKey: toDevice, recvKey: toHost, sendDir: 4, recvDir: 3 }, (f) => sentByHost.push(f))
  return { device, host, sentByHost }
}

describe('partner route byte channel', () => {
  it('derives the same route key as the bridge', () => {
    expect(hex(routeKey(new Uint8Array(32).fill(7), new Uint8Array(16).fill(9)))).toBe('dedc1af3d85a59eba92c9a693f45a1cdf0236601f4a1aca1ca6993662bacdcd2')
  })

  it('carries bytes both ways and opens nothing sealed for the session or another route', () => {
    const { device, host, sentByHost } = pair()
    const id = new Uint8Array(16).fill(3)
    const up = device.route?.(id)
    const hostUp = host.route?.(id)
    const other = host.route?.(new Uint8Array(16).fill(4))
    if (!up || !hostUp || !other) throw new Error('no route channel')
    const bytes = new Uint8Array([0, 1, 2, 255])
    const f = up.seal(bytes)
    expect(other.open(f)).toBeNull()
    expect(hostUp.open(f)).toEqual(bytes)
    expect(hostUp.open(f)).toBeNull()
    const back = hostUp.seal(new TextEncoder().encode('from the desktop'))
    expect(new TextDecoder().decode(up.open(back) ?? new Uint8Array())).toBe('from the desktop')
    // A request sealed for the session does not open on the route.
    host.send({ t: 'req', id: 1, m: 'printers.list' })
    expect(device.route?.(id).open(sentByHost[0] ?? '')).toBeNull()
  })
})
