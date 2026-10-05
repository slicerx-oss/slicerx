// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tools the MCP server adds next to mimir's registry: the project an
// outside client works on, and printer controls the app exposes as buttons
// (temperatures, filament load and unload, a G-code line). They are written
// as mimir tools so the same permission gate and approval tokens apply.
import { readFileSync } from 'node:fs'
import type { ApprovalToken, PrinterHost } from '@slicerx/contracts'
import { defineTool, type PilotTool, type ToolContext } from '@slicerx/pilot'
import { z } from 'zod'
import type { DataStore } from './data'
import { resolveModel, type PathPolicy } from './models'
import type { ProfileCatalog } from './profiles'
import { McpProject } from './project'
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
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Load an STL model (absolute path or http(s) URL) into the open project, with a number of copies. New objects go on plate 1.',
    input: z.object({
      model: z.string().min(1).describe('Absolute path or http(s) URL of an STL file, or a built-in test model such as sample:cube-20'),
      copies: z.number().int().min(1).max(200).default(1),
    }),
    async run(i) {
      const project = need()
      const path = await resolveModel(deps.policy, i.model)
      const bytes = readFileSync(path)
      const name = path.split(/[\\/]/).pop() ?? 'model.stl'
      const handle = await deps.slicer.loadModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, name)
      const obj = project.addMesh(handle.id, name, handle.bboxMm, handle.triangles, i.copies)
      return { summary: `Added ${name} (${handle.bboxMm.join(' x ')} mm) x${i.copies}`, output: { object: { id: obj.id, name, bbox_mm: handle.bboxMm, triangles: handle.triangles }, project: project.describe() } }
    },
  })

  const show = defineTool({
    name: 'project.show',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Show the open project: printer, filament, objects, plates and setting overrides.',
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

  return [open, add, show, setOverrides, temperature, filament, gcode] as PilotTool<never>[]
}
