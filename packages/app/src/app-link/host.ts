// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's side of the app link: this window hosts the link on the hub, answers agents' calls through the methods in
// methods.ts, and puts the hub's questions about new clients in front of the person (prompt.tsx).
import { createStore, useStore } from 'zustand'
import type { BridgeAppLink } from '../link/bridge'
import { LinkError, runCall } from './methods'

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
export function hostAppLink(link: BridgeAppLink): () => void {
  linkAsks.setState({ link, asks: [] })
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const stopCall = link.onCall((c) => {
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
  void link.host().catch(() => undefined)
  return () => {
    stopCall()
    stopAsk()
    stopEnded()
    for (const t of timers) clearTimeout(t)
    linkAsks.setState({ link: null, asks: [] })
  }
}
