// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Gzip for mesh uploads, through the runtime's own CompressionStream (browsers, the desktop webview, Node). A runtime
// without it, such as the phone's JavaScript engine, sends meshes as they are.

/** Gzip compresses bytes. */
export type Gzip = (data: Uint8Array) => Promise<Uint8Array>

/** Gzip through CompressionStream, or null when the runtime has none. Needs ReadableStream too, which every runtime with CompressionStream has. */
export function streamGzip(): Gzip | null {
  if (typeof globalThis.CompressionStream !== 'function') return null
  // A stream of its own, read chunk by chunk: some runtimes' Blob has no stream() (jsdom, older webviews).
  return async (data) => {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(data)
        c.close()
      },
    })
    const reader = source.pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
    }
    const out = new Uint8Array(size)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }
}

const MB = 1024 * 1024

/** A size as people read it: bytes under 1 KB, KB under 0.1 MB, else MB with one decimal (MB of 1024 KB, as the limits count). */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < MB / 10) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / MB) * 10) / 10} MB`
}
