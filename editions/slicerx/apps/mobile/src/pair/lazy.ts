// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The paired host resolves its camera and push registrar per connection (they exist only when the
// computer's hub offers them). These adapters give the app one stable object each, which asks the
// connection on first use. A host without them rejects the call, which sends the camera seam to
// stills and leaves push unregistered.
import type { PairedPrinterHost } from '@slicerx/pair'
import type { PairedCamera } from '../camera/feed'
import type { PushRegistrar } from '../notify/push'

function once<T>(get: () => Promise<T | null>): () => Promise<T | null> {
  let p: Promise<T | null> | null = null
  return () => {
    // A failed lookup is retried on the next call, so a dropped connection does not stick.
    p ??= get().catch(() => {
      p = null
      return null
    })
    return p
  }
}

export function lazyCamera(host: Pick<PairedPrinterHost, 'camera'>, via?: () => Promise<'lan' | 'relay'>, stun?: () => Promise<string | null>): PairedCamera {
  const resolve = once(() => host.camera())
  const need = async () => {
    const c = await resolve()
    if (!c) throw new Error('This computer has no live camera')
    return c
  }
  const listen = <T>(pick: (c: NonNullable<Awaited<ReturnType<typeof resolve>>>) => (cb: (v: T) => void) => () => void) => (cb: (v: T) => void) => {
    let off: (() => void) | null = null
    let gone = false
    void resolve().then((c) => {
      if (c && !gone) off = pick(c)(cb)
    })
    return () => {
      gone = true
      off?.()
    }
  }
  return {
    open: async (id, o) => (await need()).open(id, o),
    setQuality: async (s, q) => (await need()).setQuality(s, q),
    close: async (s) => (await need()).close(s),
    rtc: async (id, offer) => {
      const c = await need()
      if (!c.rtc) throw new Error('This computer has no direct video')
      return c.rtc(id, offer)
    },
    stun: async () => (stun ? stun() : null),
    remote: async () => (via ? (await via()) === 'relay' : false),
    onFrame: listen((c) => c.onFrame),
    onStats: listen((c) => c.onStats),
    onEnded: listen((c) => c.onEnded),
  }
}

export function lazyPush(host: Pick<PairedPrinterHost, 'push'>): PushRegistrar {
  const resolve = once(() => host.push())
  const need = async () => {
    const p = await resolve()
    if (!p) throw new Error('This computer sends no alerts')
    return p
  }
  return {
    register: async (r) => (await need()).register(r),
    unregister: async (t) => (await need()).unregister(t),
  }
}
