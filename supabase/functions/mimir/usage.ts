// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the provider's event stream as it passes through: what the call used (for the
// caps) and the reply's text, tool calls and stop reason (for shared sessions). What it
// passes on folds the cache counts into the input count, since every install shares one
// cache and the counts would tell one install what another sent.

export interface Usage {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  searches: number
}

export interface Reply {
  content: Record<string, unknown>[]
  stopReason: string | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

// folds cache reads and writes into the input count, in place; true when it changed anything
function fold(u: unknown): boolean {
  if (typeof u !== 'object' || u === null) return false
  const o = u as Record<string, unknown>
  if (o['cache_creation_input_tokens'] === undefined && o['cache_read_input_tokens'] === undefined && o['cache_creation'] === undefined) return false
  o['input_tokens'] = num(o['input_tokens']) + num(o['cache_creation_input_tokens']) + num(o['cache_read_input_tokens'])
  o['cache_creation_input_tokens'] = 0
  o['cache_read_input_tokens'] = 0
  delete o['cache_creation']
  return true
}
const MAX_REPLY_CHARS = 200_000

export class StreamTap {
  usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, searches: 0 }
  reply: Reply = { content: [], stopReason: null }
  /** The provider sent message_stop. */
  complete = false
  /** The provider sent an error event. */
  failed = false
  private buf = ''
  private chars = 0
  private partial = new Map<number, string>()
  private dec = new TextDecoder()

  /** Reads a chunk; returns the complete events in it, as they pass on. */
  push(chunk: Uint8Array): string {
    this.buf += this.dec.decode(chunk, { stream: true })
    let out = ''
    let i: number
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const ev = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 2)
      out += this.event(ev) + '\n\n'
    }
    return out
  }

  /** Reads what is left; returns it as it passes on. */
  end(): string {
    this.buf += this.dec.decode()
    const out = this.buf.trim() ? this.event(this.buf) : this.buf
    this.buf = ''
    for (const [i, json] of this.partial) {
      const b = this.reply.content[i]
      if (!b) continue
      try {
        b['input'] = JSON.parse(json || '{}')
      } catch {
        b['input'] = { _unparsed: json.slice(0, 2000) }
      }
    }
    this.partial.clear()
    return out
  }

  // reads one event and returns it as it passes on
  private event(raw: string): string {
    const lines = raw.split(/\r?\n/)
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
    if (!data) return raw
    let e: Record<string, unknown>
    try {
      e = JSON.parse(data)
    } catch {
      return raw
    }
    this.read(e)
    const u = e['type'] === 'message_start' ? (e['message'] as Record<string, unknown> | undefined)?.['usage'] : e['type'] === 'message_delta' ? e['usage'] : undefined
    if (!fold(u)) return raw
    return [...lines.filter((l) => !l.startsWith('data:')), `data: ${JSON.stringify(e)}`].join('\n')
  }

  private read(e: Record<string, unknown>): void {
    const type = e['type']
    if (type === 'message_stop') this.complete = true
    else if (type === 'error') this.failed = true
    else if (type === 'message_start') {
      const u = ((e['message'] as Record<string, unknown> | undefined)?.['usage'] ?? {}) as Record<string, unknown>
      this.usage.input = num(u['input_tokens'])
      this.usage.cacheWrite = num(u['cache_creation_input_tokens'])
      this.usage.cacheRead = num(u['cache_read_input_tokens'])
      this.usage.output = Math.max(this.usage.output, num(u['output_tokens']))
    } else if (type === 'message_delta') {
      // usage on message_delta is cumulative for the message
      const u = (e['usage'] ?? {}) as Record<string, unknown>
      this.usage.output = Math.max(this.usage.output, num(u['output_tokens']))
      if (u['input_tokens'] !== undefined) this.usage.input = Math.max(this.usage.input, num(u['input_tokens']))
      if (u['cache_creation_input_tokens'] !== undefined) this.usage.cacheWrite = Math.max(this.usage.cacheWrite, num(u['cache_creation_input_tokens']))
      if (u['cache_read_input_tokens'] !== undefined) this.usage.cacheRead = Math.max(this.usage.cacheRead, num(u['cache_read_input_tokens']))
      const stu = (u['server_tool_use'] ?? {}) as Record<string, unknown>
      this.usage.searches = Math.max(this.usage.searches, num(stu['web_search_requests']))
      const d = (e['delta'] ?? {}) as Record<string, unknown>
      if (typeof d['stop_reason'] === 'string') this.reply.stopReason = d['stop_reason']
    } else if (type === 'content_block_start') {
      const i = num(e['index'])
      const b = { ...((e['content_block'] ?? {}) as Record<string, unknown>) }
      if (b['type'] === 'tool_use' || b['type'] === 'server_tool_use') this.partial.set(i, '')
      this.reply.content[i] = b
    } else if (type === 'content_block_delta') {
      const i = num(e['index'])
      const b = this.reply.content[i]
      const d = (e['delta'] ?? {}) as Record<string, unknown>
      if (!b) return
      if (d['type'] === 'text_delta' && typeof d['text'] === 'string' && this.chars < MAX_REPLY_CHARS) {
        b['text'] = String(b['text'] ?? '') + d['text']
        this.chars += d['text'].length
      } else if (d['type'] === 'input_json_delta' && typeof d['partial_json'] === 'string' && this.chars < MAX_REPLY_CHARS) {
        this.partial.set(i, (this.partial.get(i) ?? '') + d['partial_json'])
        this.chars += d['partial_json'].length
      }
    }
  }
}
