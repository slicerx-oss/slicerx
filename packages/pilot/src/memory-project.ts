// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An in-memory PilotProject: objects, plates and overrides with a config built
// from the filament's knowledge defaults. Used by the evals, the dev harness
// and hosts without a project store of their own (the MCP server).
import type { MeshPart, PilotMachine, Plate, PrintConfig, SettingValue, SliceWarning } from '@slicerx/contracts'
import type { KnowledgeBase } from './kb/kb'
import type { PilotProject, ProjectObject, ProjectPlate } from './project'

export interface MemoryObject {
  id: string
  name: string
  bboxMm: [number, number, number]
  metadata?: Record<string, string>
  mesh?: () => Promise<MeshPart[]>
}

export interface MemoryProject extends PilotProject {
  appliedOverrides(): Record<string, SettingValue>
  replaced: string[]
}

const round = (v: number): number => Math.round(v * 100) / 100

/** 4x4 column-major transform for X, then Y, then Z rotations in degrees. */
export function rotationMatrix([rx, ry, rz]: [number, number, number]): number[] {
  const r = (d: number): number => (d * Math.PI) / 180
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(r(rx)), Math.sin(r(rx)), Math.cos(r(ry)), Math.sin(r(ry)), Math.cos(r(rz)), Math.sin(r(rz))]
  // R = Rz * Ry * Rx
  const m = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ]
  const e = (i: number, j: number): number => Math.round((m[i]?.[j] ?? 0) * 1e9) / 1e9
  return [e(0, 0), e(1, 0), e(2, 0), 0, e(0, 1), e(1, 1), e(2, 1), 0, e(0, 2), e(1, 2), e(2, 2), 0, 0, 0, 0, 1]
}

/** The axis-aligned size of a box after a rotation. */
export function rotatedBox(size: [number, number, number], rotate: [number, number, number]): [number, number, number] {
  const t = rotationMatrix(rotate)
  const col = (j: number): number => Math.abs(t[j] ?? 0) * size[0] + Math.abs(t[j + 4] ?? 0) * size[1] + Math.abs(t[j + 8] ?? 0) * size[2]
  return [round(col(0)), round(col(1)), round(col(2))]
}

export interface MemoryProjectOptions {
  /** Layers the host's own profiles over the knowledge defaults (printer, filament, process, Orca). Overrides still win. */
  config?: (base: PrintConfig, plateIndex: number) => PrintConfig
  /** The host's current slice warnings for a plate (`PilotProject.warnings`). */
  warnings?: (plateIndex: number) => Promise<SliceWarning[] | null>
}

export function createMemoryProject(name: string, machine: PilotMachine, objects: MemoryObject[], kb: KnowledgeBase, opts: MemoryProjectOptions = {}): MemoryProject {
  let objs: ProjectObject[] = objects.map((o) => {
    const po: ProjectObject = { id: o.id, name: o.name, bboxMm: o.bboxMm }
    if (o.metadata) po.metadata = o.metadata
    if (o.mesh) po.mesh = o.mesh
    return po
  })
  let plates: ProjectPlate[] = objs.length ? [{ index: 1, items: [{ objectId: objs[0]?.id ?? '', copies: 1 }] }] : []
  const overrides: Record<string, SettingValue> = {}
  const replaced: string[] = []
  const modeled = new Map<string, [number, number, number]>()
  const mat = kb.get('filament', machine.material)
  const defaults = (mat?.data['pilot_defaults'] ?? {}) as Record<string, SettingValue>
  return {
    name,
    replaced,
    machine: () => machine,
    ...(opts.warnings ? { warnings: opts.warnings } : {}),
    objects: () => objs,
    plates: () => plates,
    setPlates(p) {
      plates = p
    },
    overrides: () => ({ ...overrides }),
    setOverrides(changes) {
      Object.assign(overrides, changes)
    },
    appliedOverrides: () => ({ ...overrides }),
    config(plateIndex): PrintConfig {
      const nozzle = machine.nozzle
      const cfg: PrintConfig = {
        layer_height: 0.2,
        initial_layer_print_height: 0.2,
        wall_loops: 2,
        top_shell_layers: 5,
        bottom_shell_layers: 3,
        sparse_infill_density: 15,
        sparse_infill_pattern: 'grid',
        line_width: round(nozzle * 1.05),
        brim_type: 'no_brim',
        brim_width: 0,
        enable_support: false,
        nozzle_diameter: [nozzle],
        nozzle_temperature: [Number(defaults['nozzle_temperature'] ?? 220)],
        printable_area: [[0, 0], [256, 0], [256, 256], [0, 256]],
        printable_height: 256,
        gcode_flavor: 'marlin2',
        ...defaults,
      }
      const layered = opts.config ? opts.config(cfg, plateIndex) : cfg
      for (const [k, v] of Object.entries(overrides)) layered[k] = k === 'nozzle_temperature' && typeof v === 'number' ? [v] : v
      return layered
    },
    async plate(index): Promise<Plate> {
      const p = plates.find((x) => x.index === index)
      if (!p) throw new Error(`No plate ${index}`)
      return {
        bed: { widthMm: 256, depthMm: 256, heightMm: 256 },
        objects: p.items.flatMap((it) =>
          Array.from({ length: it.copies }, (_, k) => ({ id: `${it.objectId}#${k + 1}`, name: objs.find((o) => o.id === it.objectId)?.name ?? it.objectId, mesh: it.objectId, transform: rotationMatrix(it.rotate ?? [0, 0, 0]) })),
        ),
      }
    },
    async addObject(obj, parts) {
      const po: ProjectObject = { ...obj, mesh: async () => parts }
      objs = [...objs.filter((o) => o.id !== obj.id), po]
      plates = [...plates, { index: plates.length + 1, items: [{ objectId: obj.id, copies: 1 }] }]
    },
    setRotation(objectId, rotate, label) {
      plates = plates.map((p) => ({ ...p, items: p.items.map((it) => (it.objectId === objectId ? { ...it, rotate, ...(label ? { rotation: label } : {}) } : it)) }))
      const o = objs.find((x) => x.id === objectId)
      if (o) {
        // Rotations are absolute, so always start from the size as modeled.
        const base = modeled.get(objectId) ?? o.bboxMm
        modeled.set(objectId, base)
        o.bboxMm = rotatedBox(base, rotate)
      }
    },
    replaceObjects(ids, reps) {
      replaced.push(...ids)
      objs = [...objs.filter((o) => !ids.includes(o.id)), ...reps]
      plates = reps.map((r, k) => ({ index: k + 1, items: [{ objectId: r.id, copies: 1 }] }))
    },
  }
}

