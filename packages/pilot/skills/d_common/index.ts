// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Helpers for the printer, profile, sharing and planning skills.
import type { KbDoc } from '../../src/kb/kb'
import type { ToolContext } from '../../src/tool'

export type Rec = Record<string, unknown>
export const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string')

/** One line of untrusted text: no line breaks, no markdown control characters, capped length. */
export function oneLine(s: string, max = 120): string {
  const t = s.replace(/[\r\n\t]+/g, ' ').replace(/[`|<>]/g, '').trim()
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

export async function sha256Text(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function filamentDoc(ctx: ToolContext, name: string): KbDoc | undefined {
  return ctx.kb.get('filament', name) ?? ctx.kb.search(name, { kinds: ['filament'], limit: 1 })[0]?.doc
}

export function printerDoc(ctx: ToolContext, vendor: string, model: string): KbDoc | undefined {
  return ctx.kb.get('printer', `${vendor} ${model}`) ?? ctx.kb.get('printer', model) ?? ctx.kb.search(`${vendor} ${model}`, { kinds: ['printer'], limit: 1 })[0]?.doc
}

const NAMED: Record<string, [number, number, number]> = {
  black: [17, 17, 17],
  white: [242, 242, 242],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  red: [239, 68, 68],
  orange: [249, 115, 22],
  yellow: [234, 179, 8],
  green: [34, 197, 94],
  blue: [59, 130, 246],
  purple: [168, 85, 247],
  pink: [236, 72, 153],
  teal: [20, 184, 166],
  brown: [120, 72, 40],
  cyan: [6, 182, 212],
  magenta: [217, 70, 239],
  lime: [132, 204, 22],
  navy: [30, 58, 138],
  silver: [192, 192, 192],
  gold: [212, 175, 55],
  beige: [222, 206, 176],
}

/** "#3b82f6" or a common color name to RGB; null when unknown. */
export function parseColor(c: string | undefined): [number, number, number] | null {
  if (!c) return null
  const t = c.trim().toLowerCase()
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(t)
  if (m?.[1]) {
    const n = Number.parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return NAMED[t] ?? null
}

/** Euclidean RGB distance, 0 to about 441. */
export function colorDistance(a: string | undefined, b: string | undefined): number | null {
  const x = parseColor(a)
  const y = parseColor(b)
  if (!x || !y) return null
  return Math.round(Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]))
}

/** Compatibility of a filament with the Bambu AMS family, from the filament's multi_material block. */
export interface AmsFit {
  ams: 'compatible' | 'not_compatible' | 'unknown'
  ht: 'compatible' | 'not_compatible' | 'unknown'
  note?: string
  sources: string[]
}

export function amsFit(doc: KbDoc | undefined): AmsFit {
  const mm = obj(doc?.data['multi_material'])
  const pick = (k: string): 'compatible' | 'not_compatible' | 'unknown' => {
    const v = mm[k]
    return v === 'compatible' || v === 'not_compatible' ? v : 'unknown'
  }
  const fit: AmsFit = { ams: pick('bambu_ams'), ht: pick('bambu_ams_ht'), sources: strs(mm['src']) }
  if (typeof mm['note'] === 'string') fit.note = mm['note'].replace(/\s+/g, ' ').trim()
  return fit
}

/** Bare tool names a plugin manifest declares for a printer, such as "status" or "config". */
export async function pluginTools(ctx: ToolContext, pluginId: string): Promise<string[]> {
  const ms = await ctx.host.printers.plugins().catch(() => [])
  const m = ms.find((x) => x.id === pluginId)
  return (m?.tools ?? []).map((t) => (t.name.startsWith(`${pluginId}.`) ? t.name.slice(pluginId.length + 1) : t.name))
}

export function hasCapability(ms: { id: string; capabilities: string[] }[], pluginId: string, cap: string): boolean {
  return ms.find((m) => m.id === pluginId)?.capabilities.includes(cap) ?? false
}

/** A config tool a printer plugin may declare: named config, set_config or configure. */
export function configToolName(tools: string[]): string | undefined {
  return tools.find((t) => t === 'config' || t === 'set_config' || t === 'configure')
}
