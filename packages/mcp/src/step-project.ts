// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A STEP or IGES file into the server's open project, for slicerx_project_add_model: read with the optional STEP reader
// (in a worker, with its caps), an object per object of the file with a part per body, and with body colors applied,
// each colored body on the filament planned for its color (body-filaments.ts), the filaments it needs added.
import { basename } from 'node:path'
import { productName } from '@slicerx/contracts'
import { planBodyFilaments } from './body-filaments'
import { ToolInputError } from './errors'
import type { McpProject } from './project'
import type { NodeSlicerHost } from './slicerhost'
import { reader } from './toolbox/step-read'

export interface StepAdded {
  objects: { id: string; name: string; parts: number; bbox_mm: [number, number, number]; triangles: number; part_filaments: { part: string; color: string | null; filament: number }[] }[]
  filaments_added: { filament: number; color: string }[]
}

export async function addStepModel(project: McpProject, slicer: NodeSlicerHost, path: string, copies: number, colors: 'apply' | 'ignore'): Promise<StepAdded> {
  const step = await reader(path)
  const name = basename(path)
  let read
  try {
    read = await step.readStepFileInWorker(path, { name, appName: productName() })
  } catch (e) {
    if (e instanceof step.StepError) throw new ToolInputError(`${name} ${e.message}`, `step_${e.code}`, { step_code: e.code })
    throw e
  }
  const bodyColors = read.objects.flatMap((o) => o.bodies.map((b) => b.color ?? null))
  const filamentsAdded: StepAdded['filaments_added'] = []
  let slots: number[] = bodyColors.map(() => 1)
  if (colors === 'apply' && bodyColors.some((c) => c)) {
    // A filament the project only has by default (nothing set) may take a color, except filament 1 while anything
    // prints with it: the objects already in the project, or a body here without a color.
    const busy = project.objects().length > 0 || bodyColors.some((c) => !c)
    const plan = planBodyFilaments(bodyColors, project.filaments().map((f) => ({ color: f.color, free: f.source === 'profile' && !(f.slot === 1 && busy) })))
    for (const a of [...plan.add].sort((x, y) => x.slot - y.slot)) {
      while (project.filaments().length < a.slot - 1) project.addFilament({})
      if (a.slot <= project.filaments().length) project.setFilament(a.slot, { color: a.color })
      else project.addFilament({ color: a.color })
      filamentsAdded.push({ filament: a.slot, color: a.color })
    }
    slots = plan.picks.map((p) => p?.slot ?? 1)
  }
  const objects: StepAdded['objects'] = []
  let k = 0
  for (const o of read.objects) {
    const parts = o.bodies.map((b) => ({ name: b.name, slot: slots[k++]!, positions: Float32Array.from(b.positions), indices: b.indices }))
    const handle = await slicer.loadParts(o.name, parts)
    const obj = project.addMesh(handle.id, o.name, handle.bboxMm, handle.triangles, copies, parts.length)
    objects.push({
      id: obj.id,
      name: o.name,
      parts: parts.length,
      bbox_mm: handle.bboxMm,
      triangles: handle.triangles,
      part_filaments: parts.map((p, j) => ({ part: p.name, color: o.bodies[j]!.color ?? null, filament: p.slot })),
    })
  }
  return { objects, filaments_added: filamentsAdded }
}
