// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person's files on a message, turned into what the model reads: pictures as images, PDFs as documents. The same
// limits hold everywhere a message comes from (the chat, the app link, a client): four files, 10 MB each, and a cap on
// what one conversation carries, since every later request sends its files again.
import type { PilotAttachment } from '@slicerx/contracts'
import { ASSISTANT_NAME } from './name'
import type { LlmDocument, LlmImage, LlmMessage } from './provider/types'

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const DOCUMENT_TYPES = ['application/pdf'] as const

/** What a message may carry: pictures and PDFs up to 10 MB each, four at most. */
export const FILE_LIMITS = {
  types: [...IMAGE_TYPES, ...DOCUMENT_TYPES] as readonly string[],
  maxBytes: 10 * 1024 * 1024,
  maxCount: 4,
  /** What one conversation's files may add up to, as sent (pictures after they are scaled down). */
  maxConversationBytes: 15 * 1024 * 1024,
} as const

/** Providers that read PDFs. A local server (Ollama, LM Studio) takes pictures only. */
export function readsDocuments(provider: string): boolean {
  return provider !== 'openai-compatible'
}

export interface ModelFiles {
  images: LlmImage[]
  documents: LlmDocument[]
  /** Each file in words for the request text, such as "bracket.pdf (PDF)". */
  names: string[]
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[a-z-]+=[^;,]*)*;base64,([A-Za-z0-9+/=\s]*)$/i

/** Bytes a base64 string decodes to. */
export function decodedBytes(b64: string): number {
  const s = b64.replace(/\s/g, '')
  return Math.floor((s.length * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0)
}

/** Bytes of files a conversation already carries. */
export function conversationFileBytes(messages: readonly LlmMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const f of [...(m.images ?? []), ...(m.documents ?? [])]) n += decodedBytes(f.data)
  }
  return n
}

const mb = (n: number): string => `${Math.round(n / (1024 * 1024))} MB`

/**
 * The files for the model, or why they can't go, in words for the person. `provider` decides whether PDFs can be
 * read; `carried` is what the conversation already holds.
 */
export function modelFiles(files: readonly PilotAttachment[], provider: string, carried = 0): ModelFiles | { problem: string } {
  const out: ModelFiles = { images: [], documents: [], names: [] }
  if (files.length > FILE_LIMITS.maxCount) return { problem: `A message holds up to ${FILE_LIMITS.maxCount} files.` }
  let total = carried
  for (const f of files) {
    const m = DATA_URL.exec(f.url)
    const type = (m?.[1] ?? f.type).toLowerCase()
    if (!m || !FILE_LIMITS.types.includes(type)) return { problem: `${f.name} isn't an image or a PDF. Add a PNG, JPEG, WebP, GIF or PDF.` }
    const data = m[2]!.replace(/\s/g, '')
    const bytes = decodedBytes(data)
    if (bytes > FILE_LIMITS.maxBytes) return { problem: `${f.name} is over 10 MB.` }
    total += bytes
    if ((DOCUMENT_TYPES as readonly string[]).includes(type)) {
      if (!readsDocuments(provider)) {
        return { problem: `The local model can't read PDFs, so ${f.name} wasn't sent. Attach a picture of the drawing instead, or switch to ${ASSISTANT_NAME} cloud or your own key in Settings > ${ASSISTANT_NAME}.` }
      }
      out.documents.push({ mime: 'application/pdf', data, name: f.name })
      out.names.push(`${f.name} (PDF)`)
    } else {
      out.images.push({ mime: type as LlmImage['mime'], data })
      out.names.push(`${f.name} (picture)`)
    }
  }
  if (total > FILE_LIMITS.maxConversationBytes) {
    return { problem: `These files would take this conversation over ${mb(FILE_LIMITS.maxConversationBytes)} of files. Start a new conversation to send them.` }
  }
  return out
}
