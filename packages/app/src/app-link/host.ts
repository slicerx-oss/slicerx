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
}

/** Questions waiting for the person, oldest first. */
export const linkAsks = createStore<{ asks: LinkAsk[]; link: BridgeAppLink | null }>()(() => ({ asks: [], link: null }))

export function useLinkAsks(): LinkAsk[] {
  return useStore(linkAsks, (s) => s.asks)
}

/** Answers a question and takes it off the list. */
export async function answerAsk(ask: LinkAsk, decision: 'allow' | 'read' | 'deny'): Promise<void> {
  linkAsks.setState((s) => ({ asks: s.asks.filter((a) => a.askId !== ask.askId) }))
  await linkAsks.getState().link?.answer(ask.askId, decision)
}

/** Hosts the link on the hub; returns how to stop. */
export function hostAppLink(link: BridgeAppLink): () => void {
  linkAsks.setState({ link, asks: [] })
  const stopCall = link.onCall((c) => {
    runCall(c.method, c.args).then(
      (value) => link.reply(c.callId, { ok: true, value: value ?? null }),
      (e: unknown) =>
        link.reply(c.callId, {
          ok: false,
          code: e instanceof LinkError ? e.code : 'app_error',
          message: e instanceof Error ? e.message : String(e),
        }),
    ).catch(() => undefined)
  })
  const stopAsk = link.onAsk((a) => linkAsks.setState((s) => ({ asks: [...s.asks.filter((x) => x.clientId !== a.clientId), a] })))
  void link.host().catch(() => undefined)
  return () => {
    stopCall()
    stopAsk()
    linkAsks.setState({ link: null, asks: [] })
  }
}
