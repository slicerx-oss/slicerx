// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Turns an SVG file into a plate object: every fill color is extruded to a height and becomes a part with its own
// filament slot, optionally standing on a base plate. sx-geom reads the paths, shapes and transforms; strokes, text
// and images in the file are not printed, and the engine says so in its warnings, which this shows.
import type { Host, MeshPart } from '@slicerx/contracts'
import type { SvgImport, SvgOptions } from '../geom/cad'
import { fromGeom } from '../geom/client'
import { centerOnBed, compose, dropToBed } from '../plate/transform'
import { get, markStale, set, toast, type PlateEntry } from '../state/store'

export type SvgRunner = (svg: string, options: SvgOptions) => Promise<SvgImport>

async function engine(svg: string, options: SvgOptions): Promise<SvgImport> {
  const { extrudeSvg } = await import('../geom/cad')
  return extrudeSvg(svg, options)
}

let seq = 0
const uid = () => `obj_${Date.now().toString(36)}s${(++seq).toString(36)}`

/** The options the dialog sends. Width wins over height; both are in mm. */
export interface SvgForm {
  heightMm: number
  baseMm: number
  widthMm: number | null
}

export function svgOptions(form: SvgForm): SvgOptions | string {
  if (!(form.heightMm > 0)) return 'The relief height must be more than 0 mm.'
  if (!(form.baseMm >= 0)) return 'The base thickness cannot be negative.'
  if (form.widthMm !== null && !(form.widthMm > 0)) return 'The width must be more than 0 mm.'
  return { heightMm: form.heightMm, baseMm: form.baseMm, ...(form.widthMm !== null ? { fitWidthMm: form.widthMm } : {}) }
}

/** Adds the artwork as one object on the plate and returns its id. `run` is the engine call (a test passes its own). */
export async function addSvgRelief(host: Host, name: string, svg: string, form: SvgForm, run: SvgRunner = engine): Promise<string> {
  const options = svgOptions(form)
  if (typeof options === 'string') throw new Error(options)
  const result = await run(svg, options)
  const shown = result.parts.filter((p) => p.mesh.indices.length > 0)
  if (shown.length === 0) throw new Error(`${name} has no filled shapes to print. Strokes, text and images are skipped; convert them to filled paths first.`)
  const title = name.replace(/\.svg$/i, '') || 'SVG'
  const parts: MeshPart[] = shown.map((p) => fromGeom(p.mesh, p.name || title, p.slot))
  const colors = shown.map((p) => p.color)
  const { bed } = get()
  const transform = dropToBed(parts, centerOnBed(parts, compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), bed))
  const handle = await host.slicer.loadParts(title, parts)
  const entry: PlateEntry = { id: uid(), name: title, handle, parts, colors, transform }
  set((s) => ({ plate: [...s.plate, entry], selection: entry.id, selectedIds: [entry.id] }))
  markStale()
  const size = result.sizeMm.map((v) => `${Math.round(v * 10) / 10}`).join(' x ')
  const note = `Added ${title}: ${shown.length} ${shown.length === 1 ? 'color' : 'colors'}, ${size} mm.`
  toast(result.warnings.length ? `${note} ${result.warnings.join(' ')}` : note, result.warnings.length ? 'warn' : 'ok')
  return entry.id
}
