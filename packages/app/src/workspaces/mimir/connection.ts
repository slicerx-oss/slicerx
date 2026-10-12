// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What answers in the mimir tab: nothing yet, the scripted stub, or a model. The tab's runtime reports it; the chat
// shows the battle ravens behind the conversation until a model answers.
import { createStore, useStore } from 'zustand'

export type MimirLink = 'none' | 'scripted' | 'model'

export const mimirLink = createStore<{ link: MimirLink }>()(() => ({ link: 'none' }))

export function setMimirLink(link: MimirLink): void {
  if (mimirLink.getState().link !== link) mimirLink.setState({ link })
}

export function useMimirLink(): MimirLink {
  return useStore(mimirLink, (s) => s.link)
}
