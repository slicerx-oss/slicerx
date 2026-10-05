// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tools declared in connector manifests (spoolman.check, moonraker.log, ...).
// Their output is printer or service text, so it is always untrusted.
import type { Cell, PluginManifest, ToolDisplay } from '@slicerx/contracts'
import { z } from 'zod'
import { defineTool, type PilotTool } from '../tool'

function displayFor(out: unknown): ToolDisplay[] {
  if (Array.isArray(out) && out.length > 0 && out.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    const head = [...new Set(out.flatMap((r) => Object.keys(r as object)))].slice(0, 6)
    const rows: Cell[][] = out.slice(0, 20).map((r) => head.map((h) => fmt((r as Record<string, unknown>)[h])))
    return [{ kind: 'table', head, rows }]
  }
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    return [{ kind: 'kv', rows: Object.entries(out as Record<string, unknown>).slice(0, 12).map(([k, v]) => [k, fmt(v)]) }]
  }
  if (typeof out === 'string') return [{ kind: 'text', text: out.slice(0, 2000) }]
  return []
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80)
  return String(v)
}

function summarize(name: string, out: unknown): string {
  if (Array.isArray(out)) return `${out.length} ${out.length === 1 ? 'result' : 'results'}`
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>
    if (typeof o['summary'] === 'string') return o['summary'].slice(0, 120)
    if (typeof o['state'] === 'string') return String(o['state'])
  }
  return `${name} done`
}

export function pluginToolsFrom(manifests: PluginManifest[]): PilotTool<never>[] {
  const out: PilotTool<never>[] = []
  for (const m of manifests) {
    for (const t of m.tools) {
      const bareName = t.name.startsWith(`${m.id}.`) ? t.name.slice(m.id.length + 1) : t.name
      // Printer control goes through the first-party printer.* tools, which bind
      // tokens to the exact host call; manifests only add status and the console.
      if (m.kind === 'printer' && bareName !== 'status' && bareName !== 'gcode') continue
      const name = (t.name.includes('.') ? t.name : `${m.id}.${t.name}`).toLowerCase().replace(/[^a-z0-9_.]/g, '_')
      const input = (() => {
        try {
          return z.fromJSONSchema(t.inputSchema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<unknown>
        } catch {
          return z.record(z.string(), z.unknown()) as z.ZodType<unknown>
        }
      })()
      const bare = bareName
      out.push(
        defineTool({
          name,
          version: m.version,
          source: 'plugin',
          permission: t.permission,
          description: `${t.description} (${m.name} plugin)`,
          input,
          printerFor: (i: unknown) => {
            const p = i && typeof i === 'object' ? (i as Record<string, unknown>)['printerId'] : undefined
            return typeof p === 'string' ? p : undefined
          },
          async approval(i: unknown) {
            const args = i && typeof i === 'object' ? (i as Record<string, unknown>) : {}
            if (m.kind === 'printer' && bare === 'gcode') {
              const printerId = String(args['printerId'] ?? '')
              const line = String(args['line'] ?? '')
              return {
                title: `Send G-code to ${printerId}?`,
                lines: [line.slice(0, 160)],
                printerId,
                actions: [{ action: 'printer.gcode', target: printerId, params: { printerId, line } }],
              }
            }
            return {
              title: `Run ${name}?`,
              lines: [`${m.name}: ${t.description}`, JSON.stringify(i).slice(0, 160)],
              actions: [{ action: 'plugin.call', target: m.id, params: { pluginId: m.id, tool: bare, input: i } }],
            }
          },
          async run(i: unknown, ctx) {
            const res = await ctx.host.printers.callTool(m.id, bare, i, ctx.token)
            return { summary: summarize(name, res), output: res, display: displayFor(res), untrusted: true }
          },
        }) as PilotTool<never>,
      )
    }
  }
  return out
}
