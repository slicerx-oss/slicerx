// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's side of the app link: this window hosts the link on the hub, answers agents' calls through the methods in
// methods.ts, and puts the hub's questions about new clients in front of the person (prompt.tsx).
import { createStore, useStore } from 'zustand'
import type { BridgeAppLink } from '../link/bridge'
import { LinkError, runCall, useDesignHost } from './methods'

export interface LinkAsk {
  askId: number
  clientId: string
  name: string
  createdAt: string
}

/** The hub asks one question at a time; a few more can wait here while one is answered. */
const MAX_ASKS = 3
/** The hub gives up on a question after 120 s; the app takes it down a little later even if it never hears. */
const ASK_TTL_MS = 125_000

/** Questions waiting for the person, oldest first. */
export const linkAsks = createStore<{ asks: LinkAsk[]; link: BridgeAppLink | null }>()(() => ({ asks: [], link: null }))

export function useLinkAsks(): LinkAsk[] {
  return useStore(linkAsks, (s) => s.asks)
}

const drop = (askId: number) => linkAsks.setState((s) => ({ asks: s.asks.filter((a) => a.askId !== askId) }))

/** Answers a question and takes it off the list. */
export async function answerAsk(ask: LinkAsk, decision: 'allow' | 'read' | 'deny'): Promise<void> {
  drop(ask.askId)
  await linkAsks.getState().link?.answer(ask.askId, decision)
}

/** Hosts the link on the hub; returns how to stop. */
export function hostAppLink(link: BridgeAppLink, loader?: Parameters<typeof useDesignHost>[0]): () => void {
  linkAsks.setState({ link, asks: [] })
  if (loader) void useDesignHost(loader).catch(() => undefined)
  const timers = new Set<ReturnType<typeof setTimeout>>()
  // One call at a time per agent, so no agent can keep the window busy with a stream of calls.
  const inFlight = new Set<string>()
  const stopCall = link.onCall((c) => {
    if (inFlight.has(c.client.id)) {
      void link.reply(c.callId, { ok: false, code: 'busy', message: 'this agent already has a call running in the app; wait for its answer' }).catch(() => undefined)
      return
    }
    inFlight.add(c.client.id)
    runCall(c.method, c.args)
      .then(
        (value) => link.reply(c.callId, { ok: true, value: value ?? null }),
        (e: unknown) =>
          link.reply(c.callId, {
            ok: false,
            code: e instanceof LinkError ? e.code : 'app_error',
            message: e instanceof Error ? e.message : String(e),
          }),
      )
      .catch(() => undefined)
      .finally(() => inFlight.delete(c.client.id))
  })
  const stopAsk = link.onAsk((a) => {
    // A client asks again only after its last question ended, so a repeat replaces it in place.
    linkAsks.setState((s) => {
      const rest = s.asks.filter((x) => x.clientId !== a.clientId)
      return rest.length >= MAX_ASKS ? s : { asks: [...rest, a] }
    })
    const t = setTimeout(() => {
      timers.delete(t)
      drop(a.askId)
    }, ASK_TTL_MS)
    timers.add(t)
  })
  const stopEnded = link.onAskEnded(drop)
  // One line either way, so a window that cannot host (an origin the hub does not take) shows why in the console.
  link.host().then(
    (r) => console.info(`[app link] this window hosts the app link (origin ${r.origin ?? 'none'}, ${r.on ? 'on' : 'off'})`),
    (e: unknown) => console.warn(`[app link] this window cannot host the app link: ${e instanceof Error ? e.message : String(e)}`),
  )
  return () => {
    stopCall()
    stopAsk()
    stopEnded()
    for (const t of timers) clearTimeout(t)
    linkAsks.setState({ link: null, asks: [] })
  }
}
