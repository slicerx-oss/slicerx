// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tools the MCP server adds next to mimir's registry: the project an
// outside client works on, and printer controls the app exposes as buttons
// (temperatures, filament load and unload, a G-code line). They are written
// as mimir tools so the same permission gate and approval tokens apply.
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { ApprovalToken, PrinterHost } from '@slicerx/contracts'
import { defineTool, type PilotTool, type ToolContext } from '@slicerx/pilot'
import { z } from 'zod'
import type { DataStore } from './data'
import { resolveModel, type PathPolicy } from './models'
import type { ProfileCatalog } from './profiles'
import { readStlPositions, splitBodies } from './mesh'
import { McpProject } from './project'
import { FILAMENT_TYPES, MAX_FILAMENTS } from './filaments'
import { validateConfig } from './settings'
import type { NodeSlicerHost } from './slicerhost'

export interface ProjectRef {
  current: McpProject | undefined
}

export interface LocalToolDeps {
  store: DataStore
  profiles: ProfileCatalog
  slicer: NodeSlicerHost
  policy: PathPolicy
  project: ProjectRef
}

const printerId = z.string().min(1).describe('Printer id from slicerx_printer_list, such as "bay-2"')

/** A host that can send one G-code line, directly (sx-link) or through the printer's plugin (simulator, desktop). */
export async function sendGcodeLine(host: PrinterHost, id: string, line: string, token: ApprovalToken | undefined): Promise<void> {
  const direct = (host as Partial<{ sendGcode(p: string, l: string, t: ApprovalToken): Promise<void> }>).sendGcode
  if (direct && token) return direct.call(host, id, line, token)
  const info = (await host.list()).find((p) => p.id === id)
  if (!info) throw new Error(`No printer ${id}`)
  await host.callTool(info.plugin, 'gcode', { printerId: id, line }, token)
}

async function firmware(host: PrinterHost, id: string): Promise<'klipper' | 'bambu' | 'marlin'> {
  const info = (await host.list()).find((p) => p.id === id)
  if (!info) throw new Error(`No printer ${id}`)
  return info.plugin === 'moonraker' ? 'klipper' : info.plugin === 'bambu-lan' ? 'bambu' : 'marlin'
}

function gcodeTool<I extends { printerId: string }>(spec: {
  name: string
  description: string
  input: z.ZodType<I>
  lines(i: I, fw: 'klipper' | 'bambu' | 'marlin'): string[]
  title(i: I): string
  summary(i: I): string
}): PilotTool<I> {
  const plan = async (i: I, ctx: ToolContext): Promise<string[]> => spec.lines(i, await firmware(ctx.host.printers, i.printerId))
  return defineTool<I>({
    name: spec.name,
    version: '1.0.0',
    source: 'plugin',
    permission: 'start',
    description: spec.description,
    input: spec.input,
    printerFor: (i) => i.printerId,
    // Over MCP these are person-only: the hub sends the line once a person approves it.
    async agentWork(i, ctx) {
      const lines = await plan(i, ctx)
      const line = lines[0]
      if (lines.length !== 1 || !line) throw new Error('Send one G-code line at a time so a person can approve each.')
      return { kind: 'gcode', printerId: i.printerId, line }
    },
    async approval(i, ctx) {
      const lines = await plan(i, ctx)
      return {
        title: spec.title(i),
        lines: [`Sends: ${lines.join(' ; ')}`],
        printerId: i.printerId,
        actions: lines.map((line) => ({ action: 'printer.gcode' as const, target: i.printerId, params: { printerId: i.printerId, line } })),
      }
    },
    async run(i, ctx) {
      if (!ctx.token) return { ok: false, summary: 'Not approved' }
      const lines = await plan(i, ctx)
      for (const line of lines) await sendGcodeLine(ctx.host.printers, i.printerId, line, ctx.token)
      return { summary: spec.summary(i), output: { printerId: i.printerId, sent: lines } }
    },
  })
}

export function localTools(deps: LocalToolDeps): PilotTool<never>[] {
  const need = (): McpProject => {
    if (!deps.project.current) throw new Error('No project is open. Call slicerx_project_open first.')
    return deps.project.current
  }

  const open = defineTool({
    name: 'project.open',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Start a new project for mimir skills to work on (replaces the current one). Name the printer and filament by knowledge id or name, and optionally extra profiles such as "intent:strong" or "process:fine". Then add models with slicerx_project_add_model.',
    input: z.object({
      name: z.string().min(1).max(80).default('Untitled'),
      printer: z.string().optional().describe('Printer id or name, such as "bambu_p1s" or "Prusa MK4S"'),
      filament: z.string().optional().describe('Filament id or name, such as "petg"'),
      nozzle_diameter: z.number().min(0.1).max(2).optional(),
      profiles: z.array(z.string()).max(8).default([]).describe('Extra profile ids applied after the printer and before the filament'),
    }),
    async run(i) {
      const printer = i.printer ? deps.store.findKnowledge(['printer'], i.printer) : undefined
      const filament = i.filament ? deps.store.findKnowledge(['filament'], i.filament) : undefined
      if (i.printer && !printer) return { ok: false, summary: `No printer "${i.printer}" in the knowledge base` }
      if (i.filament && !filament) return { ok: false, summary: `No filament "${i.filament}" in the knowledge base` }
      for (const p of i.profiles) if (!deps.profiles.find(p)) return { ok: false, summary: `No profile "${p}"` }
      await deps.profiles.prepare(i.profiles)
      deps.project.current = new McpProject(
        { name: i.name, profiles: i.profiles, ...(printer ? { printer: printer.id } : {}), ...(filament ? { filament: filament.id } : {}), ...(i.nozzle_diameter !== undefined ? { nozzle: i.nozzle_diameter } : {}) },
        deps.store,
        deps.profiles,
        deps.slicer,
      )
      return { summary: `Project "${i.name}" open`, output: deps.project.current.describe() }
    },
  })

  const add = defineTool({
    name: 'project.add_model',
    version: '1.1.0',
    source: 'command',
    permission: 'read',
    description:
      'Load an STL model (absolute path or http(s) URL) into the open project, with a number of copies. New objects go on plate 1. A file that holds several separate bodies loads as one object by default; bodies "parts" keeps them as one object with a part per body, "objects" loads an object per body. The answer lists each new object with its part count.',
    input: z.object({
      model: z.string().min(1).describe('Absolute path or http(s) URL of an STL file, or a built-in test model such as sample:cube-20'),
      copies: z.number().int().min(1).max(200).default(1),
      bodies: z.enum(['auto', 'parts', 'objects']).default('auto').describe('A file of several separate bodies: auto (one object, as before), parts (one object, a part per body) or objects (an object per body)'),
    }),
    async run(i) {
      const project = need()
      const path = await resolveModel(deps.policy, i.model)
      const bytes = readFileSync(path)
      const name = path.split(/[\\/]/).pop() ?? 'model.stl'
      const bodies = i.bodies === 'auto' || extname(name).toLowerCase() !== '.stl' ? [] : splitBodies(readStlPositions(bytes))
      const stem = name.replace(/\.[^.]+$/, '')
      const added: { id: string; name: string; parts: number; bbox_mm: [number, number, number]; triangles: number }[] = []
      if (bodies.length > 1 && i.bodies === 'objects') {
        for (const [k, body] of bodies.entries()) {
          const piece = `${stem} ${k + 1}`
          const handle = await deps.slicer.loadParts(piece, [{ name: piece, slot: 1, positions: body, indices: Uint32Array.from({ length: body.length / 3 }, (_, v) => v) }])
          const obj = project.addMesh(handle.id, piece, handle.bboxMm, handle.triangles, i.copies)
          added.push({ id: obj.id, name: piece, parts: 1, bbox_mm: handle.bboxMm, triangles: handle.triangles })
        }
      } else {
        const handle =
          bodies.length > 1
            ? await deps.slicer.loadParts(name, bodies.map((body, k) => ({ name: `${stem} part ${k + 1}`, slot: 1, positions: body, indices: Uint32Array.from({ length: body.length / 3 }, (_, v) => v) })))
            : await deps.slicer.loadModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, name)
        const parts = bodies.length > 1 ? bodies.length : 1
        const obj = project.addMesh(handle.id, name, handle.bboxMm, handle.triangles, i.copies, parts)
        added.push({ id: obj.id, name, parts, bbox_mm: handle.bboxMm, triangles: handle.triangles })
      }
      const first = added[0]!
      const what = added.length > 1 ? `${added.length} objects` : first.parts > 1 ? `one object of ${first.parts} parts` : `${first.bbox_mm.join(' x ')} mm`
      return {
        summary: `Added ${name} (${what}) x${i.copies}`,
        output: { object: { id: first.id, name: first.name, bbox_mm: first.bbox_mm, triangles: first.triangles, parts: first.parts }, objects: added, object_count: added.length, part_count: added.reduce((n, o) => n + o.parts, 0), project: project.describe() },
      }
    },
  })

  const show = defineTool({
    name: 'project.show',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Show the open project: printer, filament profile, its filaments (number, type, color), objects, plates and setting overrides.',
    input: z.object({}),
    async run() {
      const project = need()
      return { summary: `Project "${project.name}", ${project.objects().length} objects, ${project.plates().length} plates`, output: project.describe() }
    },
  })

  const setOverrides = defineTool({
    name: 'project.set_overrides',
    version: '1.0.0',
    source: 'settings',
    permission: 'slice',
    description: 'Set OrcaSlicer settings for the open project, such as the config_patch from slicerx_plan_settings. Changes only the project, never a saved profile.',
    input: z.object({ changes: z.record(z.string(), z.union([z.number(), z.boolean(), z.string(), z.array(z.unknown())])) }),
    async approval(i) {
      return { title: `Change ${Object.keys(i.changes).length} settings in this project?`, lines: Object.entries(i.changes).slice(0, 12).map(([k, v]) => `${k} = ${JSON.stringify(v)}`), actions: [] }
    },
    async run(i) {
      const project = need()
      const errors = validateConfig(deps.store, i.changes).filter((x) => x.severity === 'error' || x.code === 'unknown_key')
      if (errors.length) return { ok: false, summary: 'Invalid settings', output: errors }
      project.setOverrides(i.changes as Record<string, never>)
      return { summary: `${Object.keys(i.changes).length} project settings changed`, output: project.overrides() }
    },
  })

  const filamentInput = {
    type: z.string().min(2).max(8).optional().describe(`Material type: ${FILAMENT_TYPES.join(', ')}`),
    color: z.string().min(6).max(9).optional().describe('Color as #rrggbb, such as #ff5500'),
  }

  const addFilament = defineTool({
    name: 'project.add_filament',
    version: '1.0.0',
    source: 'settings',
    permission: 'slice',
    description: `Add a filament to the open project after the last one (the app's Add filament on the Slice filament rail), with a material type and a color. Unset, the type is the filament profile's and the color the default for its number. A project holds ${MAX_FILAMENTS} at most. Answers with the project, whose filaments list reads it back. Filaments a printer's AMS holds are loaded on the printer, not added here.`,
    input: z.object(filamentInput),
    async run(i) {
      const project = need()
      try {
        const f = project.addFilament(i)
        return { summary: `Added filament ${f.slot}: ${f.type} ${f.color}`, output: { filament: f, project: project.describe() } }
      } catch (e) {
        return { ok: false, summary: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  const setFilament = defineTool({
    name: 'project.set_filament',
    version: '1.0.0',
    source: 'settings',
    permission: 'slice',
    description: "Change a filament of the open project: its material type, its color, or both (the app's filament dialog, opened by clicking a ring on the Slice filament rail). What is not given stays. Answers with the project, whose filaments list reads it back.",
    input: z.object({ slot: z.number().int().min(1).max(MAX_FILAMENTS).describe('Filament number, 1-based, as slicerx_project_show lists them'), ...filamentInput }),
    async run(i) {
      const project = need()
      if (i.type === undefined && i.color === undefined) return { ok: false, summary: 'Give a type, a color or both.' }
      try {
        const f = project.setFilament(i.slot, i)
        return { summary: `Filament ${f.slot} is ${f.type} ${f.color}`, output: { filament: f, project: project.describe() } }
      } catch (e) {
        return { ok: false, summary: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  const temperature = gcodeTool({
    name: 'printer.set_temperature',
    description: 'Set a nozzle, bed or chamber target temperature on a printer (0 turns the heater off). Heats hardware, so it follows the start permission.',
    input: z.object({
      printerId,
      heater: z.enum(['nozzle', 'bed', 'chamber']),
      celsius: z.number().int().min(0).max(350),
      tool: z.number().int().min(0).max(7).optional().describe('Nozzle index on multi-nozzle printers'),
    }),
    lines: (i) => [i.heater === 'nozzle' ? `M104 S${i.celsius}${i.tool !== undefined ? ` T${i.tool}` : ''}` : i.heater === 'bed' ? `M140 S${i.celsius}` : `M141 S${i.celsius}`],
    title: (i) => `Set the ${i.heater} of ${i.printerId} to ${i.celsius} C?`,
    summary: (i) => `${i.printerId} ${i.heater} target ${i.celsius} C`,
  })

  const filament = gcodeTool({
    name: 'printer.filament',
    description: 'Load or unload filament: M701 or M702 on Marlin and Prusa firmware, the LOAD_FILAMENT or UNLOAD_FILAMENT macros on Klipper. Bambu Lab printers with an AMS change filament through the printer instead.',
    input: z.object({ printerId, action: z.enum(['load', 'unload']) }),
    lines: (i, fw) => {
      if (fw === 'bambu') throw new Error('Bambu Lab printers load and unload filament from the printer screen or the AMS; there is no G-code for it here.')
      if (fw === 'klipper') return [i.action === 'load' ? 'LOAD_FILAMENT' : 'UNLOAD_FILAMENT']
      return [i.action === 'load' ? 'M701' : 'M702']
    },
    title: (i) => `${i.action === 'load' ? 'Load' : 'Unload'} filament on ${i.printerId}?`,
    summary: (i) => `${i.printerId} filament ${i.action}`,
  })

  const gcode = gcodeTool({
    name: 'printer.gcode',
    description: 'Send one G-code line to a printer console, such as "G28" or "M106 S128". It can heat and move hardware, so it follows the start permission.',
    input: z.object({ printerId, line: z.string().min(1).max(200).regex(/^[^\r\n]+$/, 'One line only') }),
    lines: (i) => [i.line.trim()],
    title: (i) => `Send "${i.line.trim()}" to ${i.printerId}?`,
    summary: (i) => `${i.printerId}: sent ${i.line.trim()}`,
  })

  return [open, add, show, setOverrides, addFilament, setFilament, temperature, filament, gcode] as PilotTool<never>[]
}
