// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import { checkReadable, ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) => serverTool({
  name: 'remap_toolheads',
  title: 'Remap toolheads in a G-code file',
  version: '1.1.0',
  source: 'command',
  permission: 'read',
  toolset: 'core',
  ungated: true,
  description: 'Move the logical tools of a sliced Snapmaker U1 G-code file onto other physical toolheads, with no printer connected: every tool selection (T), indexed temperature (M104, M109, M116 and M900 T), INDEX= on SM_PRINT_PREEXTRUDE_FILAMENT and SM_PRINT_FLOW_CALIBRATE, and EXTRUDER=extruderN moves together, and comments stay as they are. Writes a new file in the server\'s output folder and returns its path, SHA-256 and how many references changed; the original is not changed. A file the rewrite cannot read safely (lowercase or glued tool words, templates, line numbers, indexed tool parameters it does not know, an embedded firmware map, a tool that extrudes but is missing from the map) is refused with remap_refused and the line. A toolhead 0 to 3 the file selects but never extrudes with, such as a start G-code that selects T0 for the bed check on a plate that prints nothing in filament 1, may be left out of the map: it stays as written and tools_kept lists it. Does not send or start a print.',
  input: z.object({
    gcode: z.string().min(1).describe('Path to the sliced .gcode file'),
    map: z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(3)).describe('Logical tool (as the file selects it, from 0) to physical toolhead 0 to 3, such as {"0": 2, "1": 3, "2": 0, "3": 1}. Every tool the file extrudes with must be in the map; a tool 0 to 3 it only selects may be left out and stays as written.'),
  }),
  hints: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
  async run(args) {
    if (!d.slicer?.remapToolheads) throw new ToolInputError(d.slicerUnavailable ?? 'Toolhead remapping needs the sx engine', 'engine_unavailable')
    const map = Object.fromEntries(Object.entries(args.map).map(([logical, physical]) => [Number(logical), physical]))
    if (Object.keys(map).length === 0) throw new ToolInputError('Map at least one tool', 'invalid_input')
    if (Object.keys(map).some((logical) => Number(logical) > 31)) throw new ToolInputError('Map tools 0 to 31 onto toolheads 0 to 3', 'invalid_input')
    const input = checkReadable(d.policy, args.gcode, ['.gcode'])
    if (extname(input).toLowerCase() !== '.gcode') throw new ToolInputError(`Expected a .gcode file, not ${basename(input)}`, 'unsupported_format')
    const dir = join(d.policy.outDir, 'remap', `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`)
    mkdirSync(dir, { recursive: true })
    const output = join(dir, basename(input))
    const r = await d.slicer.remapToolheads({ input, output, map })
    const c = r.counts
    const moved = Object.entries(r.map).map(([l, p]) => `${l}>${p}`).join(' ')
    const kept = r.toolsKept?.length ? ` Kept as written (selected, never extruding): tool ${r.toolsKept.join(', ')}.` : ''
    return {
      summary: `Remapped ${moved}: ${c.changedLines} lines changed (${c.toolChanges} tool changes, ${c.temperatures} temperatures, ${c.preextrudeIndexes} pre-extrude indexes).${kept} SHA-256 ${r.sha256}.`,
      structured: { gcode_path: r.output, sha256: r.sha256, source_sha256: r.sourceSha256, bytes: r.bytes, map: r.map, tools_used: r.toolsUsed, unused_map_tools: r.unusedMapTools, tools_kept: r.toolsKept ?? [], counts: r.counts },
    }
  },
})
