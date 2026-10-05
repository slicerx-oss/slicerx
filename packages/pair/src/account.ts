// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Joining through the account. A signed-in new device posts a hello to the account's join route;
// a trusted device reviews it and runs the same SAS handshake over the relay. The relay (the
// SlicerX cloud) only checks that both are signed in to the account; the six digits compared on
// both screens are what stop it, or anyone holding the password, from slipping a device in.
import { fromB64url } from './bytes'
import type { PairEnv } from './crypto'
import {
  createOffererState,
  offererOnHello,
  offerOverPipe,
  type OfferAttempt,
  type OfferDriverParams,
} from './handshake'
import { accountJoinRoute, accountRoutes, OFFER_TTL_MS } from './offer'
import { HelloFrame, parseFrame, type DevicePlatform, type FrameOf } from './schema'
import { relayPipe, type Pipe, type RelayConnection } from './transport'

/** A pipe for the new device: hello to the join route, then the rest to whichever reviewer answered first. */
export function accountJoinPipe(relay: RelayConnection, accountId: string, offerId: Uint8Array): Pipe {
  const routes = accountRoutes(accountId, offerId)
  let target = routes.join
  const frames = new Set<(f: string) => void>()
  const closers = new Set<() => void>()
  let open = true
  const unsub = relay.subscribe(routes.reply, (body) => {
    if (!open) return
    const f = parseFrame(body)
    if (f?.k === 'challenge' && target === routes.join) {
      const key = fromB64url(f.e)
      if (!key) return
      target = routes.reviewer(key)
    } else if (f?.k === 'challenge') {
      // A second reviewer answered late. Its handshake times out on its side.
      return
    }
    for (const cb of [...frames]) cb(body)
  })
  return {
    send: (f) => {
      if (open) relay.send(target, f)
    },
    onFrame: (cb) => {
      frames.add(cb)
      return () => frames.delete(cb)
    },
    onClose: (cb) => {
      closers.add(cb)
      return () => closers.delete(cb)
    },
    close: () => {
      if (!open) return
      open = false
      unsub()
      for (const cb of [...closers]) cb()
    },
  }
}

export interface JoinRequest {
  requestId: string
  name: string
  platform: DevicePlatform
  receivedAt: number
  /** Starts the handshake. Show the digits and ask the person to compare them with the new device. */
  review(params: OfferDriverParams): OfferAttempt | null
}

/**
 * Listens on the account's join route. Each valid hello becomes a request the person can review.
 * Requests expire with the offer TTL and each can be reviewed once.
 */
export function watchAccountJoins(env: PairEnv, relay: RelayConnection, accountId: string, onRequest: (r: JoinRequest) => void): () => void {
  const seen = new Set<string>()
  return relay.subscribe(accountJoinRoute(accountId), (body) => {
    const f = parseFrame(body)
    if (f?.k !== 'hello' || !HelloFrame.safeParse(f).success || seen.has(f.o)) return
    seen.add(f.o)
    if (seen.size > 256) seen.delete(seen.values().next().value ?? '')
    const hello: FrameOf<'hello'> = f
    const receivedAt = env.now()
    let reviewed = false
    onRequest({
      requestId: hello.o,
      name: hello.name ?? 'New device',
      platform: hello.platform ?? 'ios',
      receivedAt,
      review(params) {
        const offerId = fromB64url(hello.o)
        if (reviewed || !offerId || env.now() - receivedAt > OFFER_TTL_MS) return null
        reviewed = true
        const st = createOffererState(env, null, offerId, OFFER_TTL_MS)
        const r = offererOnHello(env, st, hello)
        if (!r.ok) return null
        const routes = accountRoutes(accountId, offerId)
        const pipe = relayPipe(relay, routes.reviewer(st.eph.publicKey), routes.reply)
        const attempt = offerOverPipe(pipe, r.ctx, r.challenge, params)
        void attempt.result.finally(() => pipe.close())
        return attempt
      },
    })
  })
}
