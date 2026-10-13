// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The MCP SDK's own refusals in plain words. Its errors read "MCP error -32602: Tool slicerx_x not found", and its
// server answers a call it refuses before or after our tool runs (an unknown tool, arguments the input schema
// rejects, output its schema rejects) with that whole message as the result's text. People and clients reading a
// refused call get the message without the JSON-RPC code in front.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const SDK_PREFIX = /^MCP error -?\d+: /

/** `text` without the "MCP error <code>: " the SDK puts in front of its messages. */
export function plainSdkText(text: string): string {
  return text.replace(SDK_PREFIX, '')
}

type Content = { type: string; text?: unknown }

/** A refused call's result with plain text. Results that are not refusals pass through unchanged. */
export function plainRefusal<T>(result: T): T {
  if (typeof result !== 'object' || result === null) return result
  const r = result as { isError?: unknown; content?: unknown }
  if (r.isError !== true || !Array.isArray(r.content)) return result
  const content = (r.content as Content[]).map((c) => (c.type === 'text' && typeof c.text === 'string' ? { ...c, text: plainSdkText(c.text) } : c))
  return { ...result, content }
}

/**
 * Makes `server` answer its refused tool calls in plain text. The SDK sets its own tools/call handler the first time a
 * tool is registered, so this runs before that: the handler it sets is wrapped, and every refusal it returns as a tool
 * result loses the prefix. Errors it throws (real protocol errors, which go back as JSON-RPC errors with their codes)
 * pass through untouched, and so does every other method.
 */
export function plainToolRefusals(server: McpServer): void {
  const inner = server.server
  const set = inner.setRequestHandler.bind(inner)
  type Handler = (request: unknown, extra: unknown) => unknown
  const wrapped = (schema: { shape?: { method?: { value?: unknown } } }, handler: Handler): void => {
    if (schema.shape?.method?.value !== 'tools/call') return (set as (s: unknown, h: Handler) => void)(schema, handler)
    ;(set as (s: unknown, h: Handler) => void)(schema, async (request, extra) => plainRefusal(await handler(request, extra)))
  }
  inner.setRequestHandler = wrapped as unknown as typeof inner.setRequestHandler
}
