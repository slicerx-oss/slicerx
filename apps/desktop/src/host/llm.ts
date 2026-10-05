// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The assistant's model transport through src-tauri/src/llm.rs. The request goes out without a
// credential; Rust adds the ChatGPT plan's token or the API key. Only response bytes come back.
import type { LlmHttpRequest, LlmTransport } from '@slicerx/contracts'
import { Channel, invoke } from '@tauri-apps/api/core'

type Chunk = { kind: 'data'; b64: string } | { kind: 'error'; status: number; message: string } | { kind: 'end' }

let nextId = 1

function bytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** Thrown for a failed request; `status` is the HTTP status, 0 when there was none. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(status ? `${status}: ${message}` : message)
  }
}

export interface DesktopLlm extends LlmTransport {
  /** Who pays now: the ChatGPT `plan`, an API `key`, or nobody (null). */
  billing(): Promise<'plan' | 'key' | null>
}

export function createTauriLlm(): DesktopLlm {
  return {
    available: (provider) => invoke<boolean>('llm_available', { provider }),
    billing: () => invoke<'plan' | 'key' | null>('llm_billing'),
    async *stream(req: LlmHttpRequest, signal?: AbortSignal): AsyncIterable<Uint8Array> {
      const id = nextId++
      const queue: Chunk[] = []
      let wake: (() => void) | undefined
      const channel = new Channel<Chunk>()
      channel.onmessage = (c) => {
        queue.push(c)
        wake?.()
        wake = undefined
      }
      const cancel = (): void => void invoke('llm_cancel', { id }).catch(() => undefined)
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        await invoke('llm_stream', { id, request: req, onChunk: channel })
        for (;;) {
          if (signal?.aborted) throw new DOMException('canceled', 'AbortError')
          const c = queue.shift()
          if (!c) {
            await new Promise<void>((resolve) => {
              wake = resolve
              signal?.addEventListener('abort', () => resolve(), { once: true })
            })
            continue
          }
          if (c.kind === 'data') yield bytes(c.b64)
          else if (c.kind === 'error') throw new LlmHttpError(c.status, c.message)
          else return
        }
      } finally {
        signal?.removeEventListener('abort', cancel)
        // Stops the request in Rust when the reader leaves early.
        cancel()
      }
    },
  }
}
