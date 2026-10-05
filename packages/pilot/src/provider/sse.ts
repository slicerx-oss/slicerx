// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

export interface SseMessage {
  event?: string
  data: string
}

/** Parses a Server-Sent Events byte stream into messages. Tolerates CRLF and chunk splits anywhere. */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncIterable<SseMessage> {
  const decoder = new TextDecoder()
  let buf = ''
  let event: string | undefined
  let data: string[] = []
  const flush = (): SseMessage | null => {
    if (data.length === 0) {
      event = undefined
      return null
    }
    const msg: SseMessage = event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') }
    event = undefined
    data = []
    return msg
  }
  const lines = function* (final: boolean): Generator<string> {
    for (;;) {
      const i = buf.search(/\r\n|\n|\r/)
      if (i < 0) break
      const nl = buf.startsWith('\r\n', i) ? 2 : 1
      // A lone \r at the very end may be the first half of \r\n in the next chunk.
      if (!final && nl === 1 && buf[i] === '\r' && i === buf.length - 1) break
      const line = buf.slice(0, i)
      buf = buf.slice(i + nl)
      yield line
    }
  }
  const handle = (line: string): SseMessage | null => {
    if (line === '') return flush()
    if (line.startsWith(':')) return null
    const c = line.indexOf(':')
    const field = c < 0 ? line : line.slice(0, c)
    let value = c < 0 ? '' : line.slice(c + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    return null
  }
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    for (const line of lines(false)) {
      const m = handle(line)
      if (m) yield m
    }
  }
  buf += decoder.decode()
  for (const line of lines(true)) {
    const m = handle(line)
    if (m) yield m
  }
  if (buf !== '') {
    const m = handle(buf)
    buf = ''
    if (m) yield m
  }
  const last = flush()
  if (last) yield last
}
