// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open sketch's dimension boxes, through the app link: the sizes a person types on the shape while sketching (a
// rectangle's width and height, a line's length and angle, a circle's diameter). Reading lists every shape with its
// boxes and the sketch's dimensions; setting one drives the shape through the sketch's solver, as typing in the box
// does, and answers with the sketch read back.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

export interface AppSketchBoxes {
  dof: number | null
  shapes: { shape: 'rectangle' | 'line' | 'circle'; loop: number; seg?: number; boxes: { box: string; label: string; value: number; unit: 'mm' | 'deg'; set: 'driving' | 'driven' | null }[] }[]
  dimensions: { index: number; type: string; value: number; driven: boolean; expr?: string }[]
  /** On a set: true when the value would over-define the sketch, so it is kept as a driven (reporting) dimension. */
  driven?: boolean
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', busy: 'busy', not_ready: 'busy', read_only: 'not_supported', denied: 'not_supported', refused: 'not_supported' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>): Promise<AppSketchBoxes> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<AppSketchBoxes>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it.`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'internal_error')
  }
}

const fmt = (v: number) => `${Number(v.toFixed(3))}`

function summary(s: AppSketchBoxes): string {
  const shapes = s.shapes.map((x) => `${x.shape} ${x.loop}${x.seg !== undefined ? `:${x.seg}` : ''} (${x.boxes.map((b) => `${b.label} ${b.set === 'driven' ? `(${fmt(b.value)})` : fmt(b.value)}${b.unit === 'deg' ? ' deg' : ' mm'}${b.set === 'driving' ? ' set' : ''}`).join(', ')})`)
  const dof = s.dof === null ? 'not solved yet' : s.dof === 0 ? 'fully defined' : `${s.dof} degree${s.dof === 1 ? '' : 's'} of freedom left`
  return `${s.driven ? 'Kept driven: it would over-define the sketch. ' : ''}${shapes.length ? shapes.join('; ') : 'No shapes with boxes'}; ${dof}.`
}

export function appSketchTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const read = defineTool({
    name: 'app.sketch_boxes',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read the dimension boxes of the sketch open in ${appName}: every rectangle (width, height), line (length, angle from the sketch's X axis) and circle (diameter) with its value now and whether a dimension sets it (driving moves the shape, driven only reports it), plus the sketch's dimensions and the degrees of freedom left. Values are mm, angles degrees. Loops and segments are numbered as slicerx_design_sketch takes them. Needs a sketch open in Model.`,
    input: z.object({}),
    async run() {
      const out = await call(link, appName, 'sketch.boxes', {})
      return { summary: summary(out), output: out }
    },
  })
  const set = defineTool({
    name: 'app.sketch_box_set',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Type a value into one dimension box of the sketch open in ${appName}, as the person does on the shape: the value becomes a driving dimension and the sketch's solver moves the shape to meet it. A value that would over-define the sketch is kept driven (it reports the size, changes nothing) and the answer says so; null takes the box's dimension away so the size is free again. Give the loop (and seg for a line) as app.sketch_boxes lists it. Returns the boxes read back.`,
    input: z.object({
      loop: z.number().int().min(0).describe('The shape\'s loop, as app.sketch_boxes lists it'),
      seg: z.number().int().min(0).optional().describe("A line's segment in its loop; not used for a rectangle or circle"),
      box: z.enum(['width', 'height', 'length', 'angle', 'diameter']).describe('width and height on a rectangle, length and angle on a line, diameter on a circle'),
      value: z.union([z.number(), z.string().trim().min(1).max(200), z.null()]).describe('mm (degrees for angle), an expression such as "6*2" or a named value, or null to free the size'),
    }),
    async run(i) {
      const out = await call(link, appName, 'sketch.box_set', { loop: i.loop, ...(i.seg !== undefined ? { seg: i.seg } : {}), box: i.box, value: i.value })
      return { summary: summary(out), output: out }
    },
  })
  return [read, set] as PilotTool<never>[]
}
