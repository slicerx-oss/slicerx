// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open project's filaments in the mimir tab: add one after the last and change one's type or color, as the filament
// rail and its dialog do, under the same names and inputs as the server's project.add_filament and project.set_filament.
// Each answers with the filament and every filament of the project as the rail now shows them, and the parts on screen
// take the new colors. The part makers that take a filament slot, and color paint, say when it was past the project's
// last filament.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { FILAMENT_TYPES, filamentColor, filamentType, MAX_FILAMENTS } from './filaments'

/** One filament as the rail shows it: its number from 1, material type and color (#rrggbb). */
export interface TabFilament {
  slot: number
  type: string
  color: string
}

/** What a filament change gives: the type, the color or both, already checked. */
export interface FilamentPatch {
  type?: string
  color?: string
}

/** The open project's filaments, as the tab reads and changes them. */
export interface FilamentList {
  /** Every filament, 1 first. */
  list(): TabFilament[]
  /** Adds filament `slot` (the one after the last) with the defaults for its number, then `patch`. */
  add(slot: number, patch: FilamentPatch): void
  /** Changes filament `slot`; what `patch` leaves out stays. */
  set(slot: number, patch: FilamentPatch): void
}

/** The tools that put a part in a filament slot: the part makers, and setting an existing part's filament. */
export const SLOT_TOOLS: ReadonlySet<string> = new Set(['geom.build', 'geom.extrude', 'geom.revolve', 'geom.loft', 'geom.sweep', 'geom.emboss', 'design.part_filament'])

/** The tab's filament tools. */
export const FILAMENT_TOOLS: readonly string[] = ['project.add_filament', 'project.set_filament']

const filamentInput = {
  type: z.string().min(2).max(8).optional().describe(`Material type: ${FILAMENT_TYPES.join(', ')}`),
  color: z.string().min(6).max(9).optional().describe('Color as #rrggbb, such as #ff5500'),
}

/** The checked patch, or the refusal in plain words. */
function patchOf(i: { type?: string | undefined; color?: string | undefined }): FilamentPatch {
  return { ...(i.type !== undefined ? { type: filamentType(i.type) } : {}), ...(i.color !== undefined ? { color: filamentColor(i.color) } : {}) }
}

const failed = (e: unknown) => ({ ok: false as const, summary: e instanceof Error ? e.message : String(e) })

/** project.add_filament and project.set_filament on `filaments`. */
export function filamentTools(filaments: FilamentList): PilotTool<never>[] {
  const answer = (slot: number, verb: string) => {
    const all = filaments.list()
    const f = all.find((x) => x.slot === slot)
    if (!f) return { ok: false as const, summary: `Filament ${slot} did not stick: the project has ${all.length}.` }
    return { summary: `${verb} filament ${f.slot}: ${f.type} ${f.color}`, output: { filament: f, filaments: all } }
  }

  const add = defineTool({
    name: 'project.add_filament',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Add a filament to the open project after the last one (Add filament on the Slice filament rail), with a material type and a color. Unset, the type is PLA and the color the default for its number. A project holds ${MAX_FILAMENTS} at most. Parts print in a filament by its number (the slot the part makers take), and show in its color. Answers with the new filament and every filament of the project.`,
    input: z.object(filamentInput),
    args: (i) => [i.type, i.color].filter(Boolean).join(' '),
    async run(i) {
      try {
        const patch = patchOf(i)
        const slot = filaments.list().length + 1
        if (slot > MAX_FILAMENTS) return { ok: false, summary: `The project already has ${MAX_FILAMENTS} filaments, the most it holds.` }
        filaments.add(slot, patch)
        return answer(slot, 'Added')
      } catch (e) {
        return failed(e)
      }
    },
  })

  const set = defineTool({
    name: 'project.set_filament',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: "Change a filament of the open project: its material type, its color, or both (the filament dialog, opened by clicking a ring on the Slice filament rail). What is not given stays. Every part printed in that filament shows the new color. Answers with the filament and every filament of the project.",
    input: z.object({ slot: z.number().int().min(1).max(MAX_FILAMENTS).describe('Filament number, 1-based, as the part makers and the rail number them'), ...filamentInput }),
    args: (i) => [String(i.slot), i.type, i.color].filter(Boolean).join(' '),
    async run(i) {
      if (i.type === undefined && i.color === undefined) return { ok: false, summary: 'Give a type, a color or both.' }
      try {
        const patch = patchOf(i)
        const n = filaments.list().length
        if (i.slot > n) return { ok: false, summary: `No filament ${i.slot}: the project has ${n}. Add one with project.add_filament.` }
        filaments.set(i.slot, patch)
        return answer(i.slot, 'Set')
      } catch (e) {
        return failed(e)
      }
    },
  })

  return [add, set] as PilotTool<never>[]
}

/**
 * `tools` with the part makers, and a color paint step, saying when their filament was past the project's last: the
 * project now has that filament (and any before it it lacked), with the default type and color, and the answer names
 * them and how to set them, so the colors on screen are never left to chance. A paint preview changes nothing, so the
 * filament is added when its preview is applied.
 */
export function withNewFilaments(tools: readonly PilotTool<never>[], filaments: FilamentList): PilotTool<never>[] {
  // the filament each color preview paints, by preview id, for when it is applied
  const painting = new Map<string, number>()
  return tools.map((t) => {
    if (t.name === 'paint.preview') {
      const run = t.run.bind(t)
      return {
        ...t,
        async run(input: never, ctx: Parameters<typeof t.run>[1]) {
          const out = await run(input, ctx)
          const i = input as { layer?: unknown; state?: unknown }
          const id = (out.output as { preview?: unknown } | undefined)?.preview
          if (out.ok !== false && typeof id === 'string' && i.layer === 'color' && typeof i.state === 'number' && i.state > 0) painting.set(id, i.state)
          return out
        },
      }
    }
    if (!SLOT_TOOLS.has(t.name) && t.name !== 'paint.apply') return t
    const run = t.run.bind(t)
    return {
      ...t,
      async run(input: never, ctx: Parameters<typeof t.run>[1]) {
        const before = filaments.list().length
        const preview = t.name === 'paint.apply' ? String((input as { preview?: unknown } | null)?.preview ?? '') : ''
        const out = await run(input, ctx)
        const slot = preview ? painting.get(preview) : (input as { slot?: unknown } | null)?.slot
        if (preview) painting.delete(preview)
        if (out.ok === false || typeof slot !== 'number' || slot <= before) return out
        // the part already prints in it (or is painted with it); adding it keeps it on the rail even if that part goes
        for (let s = before + 1; s <= slot; s++) filaments.add(s, {})
        const added = filaments.list().filter((f) => f.slot > before && f.slot <= slot)
        if (!added.length) return out
        const words = added.map((f) => `${f.slot} (${f.type} ${f.color})`).join(', ')
        const note = `The project had ${before} filament${before === 1 ? '' : 's'}, so filament${added.length === 1 ? '' : 's'} ${words} ${added.length === 1 ? 'was' : 'were'} added with the default color. Set the color with project.set_filament.`
        const output = out.output && typeof out.output === 'object' && !Array.isArray(out.output) ? { ...(out.output as Record<string, unknown>), filamentsAdded: added } : { result: out.output, filamentsAdded: added }
        return { ...out, summary: `${out.summary}. ${note}`, output }
      },
    }
  })
}
