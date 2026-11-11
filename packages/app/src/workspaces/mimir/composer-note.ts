// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The one short line under mimir's message box when Enter is pressed on a message that cannot be sent yet, so Enter never
// looks dead. It names what stops the send: no model connected, the notice before the first mimir cloud chat, or the tab
// still setting up its model.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'

export interface ComposerState {
  /** No model is connected and the chat is the setup. */
  connecting: boolean
  /** The one-time mimir cloud notice waits above the chat. */
  notice: boolean
  /** The tab's model is set up. */
  ready: boolean
  /** Turns in the chat so far. */
  turns: number
}

/** Why sending is off, in one line; undefined while a message can go. The notice comes first: it is the card on screen. */
export function composerOffNote({ connecting, notice, ready, turns }: ComposerState): string | undefined {
  if (notice) return 'Press Start above to send this.'
  // with no model connected, the line says where to connect one: the card above, or Settings once the chat has turns
  if (connecting) return turns === 0 ? 'Connect a model above to send this.' : 'Connect a model in Settings to send this.'
  if (!ready) return `${ASSISTANT_NAME} is still getting ready. Try again in a moment.`
  return undefined
}
