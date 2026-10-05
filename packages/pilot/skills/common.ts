// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Helpers shared by the skills.
import type { KnowledgeBase } from '../src/kb/kb'
import type { ToolContext } from '../src/tool'

export interface BuildVolume {
  x: number
  y: number
  z: number
  source?: string
}

/** Well known beds for printers the knowledge base does not cover yet. */
const FALLBACK: Record<string, BuildVolume> = {
  'a1 mini': { x: 180, y: 180, z: 180 },
  a1: { x: 256, y: 256, z: 256 },
  p1s: { x: 256, y: 256, z: 256 },
  p1p: { x: 256, y: 256, z: 256 },
  'x1 carbon': { x: 256, y: 256, z: 256 },
  x1c: { x: 256, y: 256, z: 256 },
  h2d: { x: 325, y: 320, z: 325 },
}

export function buildVolume(kb: KnowledgeBase, printer: string): BuildVolume | null {
  const doc = kb.get('printer', printer) ?? kb.search(printer, { kinds: ['printer'], limit: 1 })[0]?.doc
  const bv = doc?.data['build_volume_mm'] as Record<string, unknown> | undefined
  if (doc && bv && typeof bv['x'] === 'number' && typeof bv['y'] === 'number' && typeof bv['z'] === 'number') {
    return { x: bv['x'], y: bv['y'], z: bv['z'], source: doc.id }
  }
  return FALLBACK[printer.toLowerCase().replace(/^bambu( lab)?\s+/, '')] ?? null
}

/** Build volume for one of the user's printers, via its model name. */
export async function printerVolume(ctx: ToolContext, printerId: string): Promise<{ name: string; model: string; volume: BuildVolume | null } | null> {
  const info = (await ctx.host.printers.list()).find((p) => p.id === printerId)
  if (!info) return null
  return { name: info.name, model: info.model, volume: buildVolume(ctx.kb, `${info.vendor} ${info.model}`) ?? buildVolume(ctx.kb, info.model) }
}

export function pickObject(ctx: ToolContext, id?: string) {
  const objs = ctx.project?.objects() ?? []
  if (id) return objs.find((o) => o.id === id || o.name === id) ?? null
  return objs[0] ?? null
}

export const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d
