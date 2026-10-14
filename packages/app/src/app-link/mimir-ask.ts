// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client's message to mimir in the open app, with files: mimir.ask puts it in the docked chat as if the person had
// sent it (pictures and PDF drawings ride on it, under the same limits as the chat's attach button) and answers at
// once with the session; mimir.session reads back what mimir did. The chat registers itself here while it is open; a
// run already going is never interrupted.
import type { PilotAttachment } from '@slicerx/contracts'
import { decodedBytes, FILE_LIMITS } from '@slicerx/pilot'
import { LinkError } from './methods-error'

export interface MimirAsker {
  /** Whether a run is going in the chat now. */
  busy(): boolean
  /** Sends the message with its files as the person's next message; the session it went to. */
  send(text: string, files: PilotAttachment[]): string
}

let asker: MimirAsker | null = null

/** The chat that takes clients' messages registers here; null takes it away. */
export function setMimirAsker(a: MimirAsker | null): void {
  asker = a
}

const MAX_TEXT = 4_000
const B64 = /^[A-Za-z0-9+/]*={0,2}$/

/** A picture scaled down for the model when this page can, else as it came. */
async function attachment(i: number, name: string, type: string, data: string): Promise<PilotAttachment> {
  const bytes = decodedBytes(data)
  let url = `data:${type};base64,${data}`
  let sent = type
  if (type.startsWith('image/') && typeof atob === 'function') {
    const { scaledDown } = await import('@slicerx/pilot/ui')
    const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const small = await scaledDown(new Blob([raw], { type }))
    if (small) {
      url = small
      sent = 'image/jpeg'
    }
  }
  return { id: `link${Date.now().toString(36)}${i}`, name, type: sent, bytes, url }
}

/** `mimir.ask {message, files?}`: the message goes to mimir; answers with the session and what was sent. */
export async function askMimir(args: Record<string, unknown>): Promise<unknown> {
  const message = args['message']
  if (typeof message !== 'string' || message.length > MAX_TEXT) throw new LinkError('invalid_input', `message is text of at most ${MAX_TEXT} characters`)
  const raw = args['files'] ?? []
  if (!Array.isArray(raw)) throw new LinkError('invalid_input', 'files is a list of {name, type, data}')
  if (raw.length > FILE_LIMITS.maxCount) throw new LinkError('invalid_input', `A message holds up to ${FILE_LIMITS.maxCount} files.`)
  if (!message.trim() && raw.length === 0) throw new LinkError('invalid_input', 'send a message, files, or both')
  const files: PilotAttachment[] = []
  for (const [i, f] of (raw as unknown[]).entries()) {
    const { name, type, data } = (f ?? {}) as Record<string, unknown>
    if (typeof name !== 'string' || !name || name.length > 200) throw new LinkError('invalid_input', `files[${i}].name is the file's name`)
    if (typeof type !== 'string' || !FILE_LIMITS.types.includes(type)) throw new LinkError('invalid_input', `${name} isn't an image or a PDF. Add a PNG, JPEG, WebP, GIF or PDF.`)
    if (typeof data !== 'string' || !B64.test(data)) throw new LinkError('invalid_input', `files[${i}].data is the file in base64`)
    if (decodedBytes(data) > FILE_LIMITS.maxBytes) throw new LinkError('invalid_input', `${name} is over 10 MB.`)
    files.push(await attachment(i, name, type, data))
  }
  if (!asker) throw new LinkError('not_ready', 'the mimir chat is not open in the app; ask the person to open it')
  if (asker.busy()) throw new LinkError('busy', 'mimir is answering a message now; read it back with mimir.session and send again when it is done')
  const sessionId = asker.send(message.trim(), files)
  return { sessionId, said: message.trim(), attachments: files.map((f) => ({ name: f.name, type: f.type, bytes: f.bytes })) }
}
