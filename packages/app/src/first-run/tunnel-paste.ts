// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the Obico paste box read from a pasted tunnel address, kept apart from the setup form so a printer card can
// use the same rules without loading the setup screens. Only the host and whether a user name and password came with
// it are kept; the address itself, which carries the password, stays in the masked field.
import { parseTunnelEndpoint, TUNNEL_PASTE_TEXT, type TunnelPasteProblem } from '@slicerx/contracts'

/** What the Obico paste box read: the tunnel host and whether a user name and password came with it, or why it was refused. Never the credential. */
export type TunnelPaste = { host: string; credential: boolean } | { problem: TunnelPasteProblem }

/** What the paste box shows for a pasted address: its host, or why it is refused. Undefined for an empty box. */
export function readTunnelPaste(raw: string): TunnelPaste | undefined {
  if (!raw.trim()) return undefined
  const r = parseTunnelEndpoint(raw)
  return r.ok ? { host: r.host, credential: r.credential !== undefined } : { problem: r.problem }
}

export const TUNNEL_EMPTY_TEXT = 'Paste the address Obico gave you.'
export const TUNNEL_NO_CREDENTIAL_TEXT = 'This address has no user name and password. Copy the whole address from Obico.'

/** Why what the box read cannot be used, in plain words, or undefined when it can. */
export function tunnelPasteError(read: TunnelPaste | undefined): string | undefined {
  if (!read) return TUNNEL_EMPTY_TEXT
  if ('problem' in read) return TUNNEL_PASTE_TEXT[read.problem]
  return read.credential ? undefined : TUNNEL_NO_CREDENTIAL_TEXT
}
