// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Placement and per-object control of the open project, as a person does it in the app: move, rotate and scale an
// object, add, remove and fill plates, give an object its own settings, add cuts, support regions and settings
// modifiers, and set settings by height; and the model ring's object verbs (duplicate, rename, lay on a face, lock,
// leave out of the print, center, split to objects or parts). Each tool answers with the project as it is after the change
// (slicerx_project_show reads it back the same way); the next slice uses it.
import { readFileSync } from 'node:fs'
import type { SettingValue, VolumeRole } from '@slicerx/contracts'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { isGcodeKey } from './config'
import { boxPositions, cylinderPositions, meshStats, readStlPositions, transformPositions } from './mesh'
import { resolveModel, ToolInputError } from './models'
import type { McpProject } from './project'
import { isNeverImported } from './projectfile'
import { validateConfig } from './settings'
import type { LocalToolDeps } from './tools'

/** What the engine lets a height range change (packages/core/src/config.rs RANGE_KEYS). */
export const RANGE_KEYS: readonly string[] = [
  'wall_loops',
  'nozzle_temperature',
  'filament_flow_ratio',
  'enable_pressure_advance',
  'pressure_advance',
  'outer_wall_speed',
  'inner_wall_speed',
  'sparse_infill_speed',
  'internal_solid_infill_speed',
  'top_surface_speed',
  'travel_speed',
  'retraction_length',
  'retraction_speed',
  'retraction_minimum_travel',
]

const objectArg = z.string().min(1).describe('Object id (obj-1) or name, from slicerx_project_show')
const settingValue = z.union([z.number(), z.boolean(), z.string(), z.array(z.unknown())])
const settingsArg = z.record(z.string(), settingValue)
const vec3 = z.tuple([z.number(), z.number(), z.number()])

/**
 * Settings a client may give one object, a modifier or a height range: known keys with valid values, and never
 * custom G-code or a key no file may set (scripts, credentials), which would get round the printer G-code checks.
 */
function checkSettings(deps: LocalToolDeps, settings: Record<string, unknown>, only?: readonly string[]): void {
  const keys = Object.keys(settings)
  const gcode = keys.filter((k) => isGcodeKey(k) || isNeverImported(k))
  if (gcode.length) throw new ToolInputError(`${gcode.join(', ')} cannot be set per object, modifier or height. Custom G-code belongs to the printer profile.`)
  if (only) {
    const left = keys.filter((k) => !only.includes(k))
    if (left.length) throw new ToolInputError(`A height range can change only ${only.join(', ')}; not ${left.join(', ')}.`)
  }
  const errors = validateConfig(deps.store, settings as Record<string, SettingValue>).filter((x) => x.severity === 'error' || x.code === 'unknown_key')
  if (errors.length) throw new ToolInputError(`Invalid settings: ${errors.map((e) => `${e.keys.join(", ")}: ${e.message}`).join('; ')}`, 'invalid_input', { errors })
}

/**
 * The rotation, degrees about X then Y (none about Z), that turns a face with this outward normal (in the model as
 * modeled, before the object's scale) to point straight down.
 */
export function downRotation(normal: [number, number, number], scale: [number, number, number] = [1, 1, 1]): [number, number, number] {
  // A scale changes a face's direction by its inverse.
  const n = normal.map((v, k) => v / (scale[k] ?? 1))
  const len = Math.hypot(n[0]!, n[1]!, n[2]!)
  if (!(len > 1e-9)) throw new ToolInputError('The normal has no direction; give the face\'s outward normal, such as [0, 0, 1].')
  const [x, y, z] = n.map((v) => v / len) as [number, number, number]
  const r = Math.hypot(y, z)
  // About X first so the normal has no Y left and points down in YZ, then about Y to point it straight down.
  const a = r < 1e-9 ? 0 : Math.atan2(0 - y, 0 - z)
  const b = Math.atan2(x, r)
  const deg = (v: number): number => {
    const d = Math.round(((v * 180) / Math.PI) * 1e6) / 1e6
    return d === 0 ? 0 : d
  }
  return [deg(a), deg(b), 0]
}

export function placementTools(deps: LocalToolDeps, need: () => McpProject): PilotTool<never>[] {
  const done = (summary: string, project: McpProject, extra: Record<string, unknown> = {}) => ({ summary, output: { ...extra, project: project.describe() } })
  const tool = <I>(spec: { name: string; description: string; input: z.ZodType<I>; title(i: I): string; run(i: I, project: McpProject): Promise<{ summary: string; output: unknown }> | { summary: string; output: unknown } }): PilotTool<I> =>
    defineTool<I>({
      name: spec.name,
      version: '1.0.0',
      source: 'command',
      permission: 'slice',
      description: spec.description,
      input: spec.input,
      async approval(i) {
        return { title: spec.title(i), lines: [], actions: [] }
      },
      async run(i) {
        return spec.run(i, need())
      },
    })

  const move = tool({
    name: 'project.move',
    description:
      'Place an object on its plate: x and y are the center of its footprint in mm, in bed coordinates (as the printer profile\'s printable area gives them). auto: true puts it back in the automatic rows. Every object sits on the bed (its lowest point at Z 0), so there is no height to set. Further copies line up to its right. Answers with the project, whose plates list where every copy sits (placements). It stays where it is put; on a round bed a copy that reaches past the rim has offBed: true, and the slice refuses it until it is moved.',
    input: z.union([z.object({ object: objectArg, x: z.number(), y: z.number() }), z.object({ object: objectArg, auto: z.literal(true) })]),
    title: (i) => `Move ${i.object}?`,
    run(i, project) {
      const id = project.move(i.object, 'auto' in i ? null : [i.x, i.y])
      return done('auto' in i ? `${id} back in the rows` : `${id} placed at ${i.x}, ${i.y} mm`, project)
    },
  })

  const rotate = tool({
    name: 'project.rotate',
    description: 'Set an object\'s rotation in degrees about X, then Y, then Z (absolute, not added to the current one; [0, 0, 0] is as modeled). It is set down flat on the bed again. Answers with the project, including the object\'s new size.',
    input: z.object({ object: objectArg, rotate: vec3.describe('Degrees about X, Y and Z') }),
    title: (i) => `Rotate ${i.object}?`,
    run(i, project) {
      const obj = project.objects().find((o) => o.id === i.object || o.name === i.object)
      if (!obj) throw new ToolInputError(`No object ${i.object}. slicerx_project_show lists them.`)
      project.setRotation(obj.id, i.rotate)
      return done(`${obj.id} rotated to ${i.rotate.join(', ')} deg`, project)
    },
  })

  const scale = tool({
    name: 'project.scale',
    description: 'Scale an object: one factor for all axes (1.2 is 120 %), or one per axis in the object\'s own coordinates. Absolute, not added to the current scale; 1 is as modeled. Answers with the project, including the object\'s new size.',
    input: z.object({ object: objectArg, scale: z.union([z.number().positive().max(100), z.tuple([z.number().positive().max(100), z.number().positive().max(100), z.number().positive().max(100)])]) }),
    title: (i) => `Scale ${i.object}?`,
    run(i, project) {
      const s: [number, number, number] = typeof i.scale === 'number' ? [i.scale, i.scale, i.scale] : i.scale
      const id = project.setScale(i.object, s)
      return done(`${id} scaled to ${s.join(' x ')}`, project)
    },
  })

  const objectSettings = tool({
    name: 'project.object_settings',
    description:
      'Give one object its own settings (OrcaSlicer keys), over the project\'s and the plate\'s: walls, infill, top and bottom shells, supports and speeds. Temperatures, fans and retraction follow the plate. Layer height may differ only when the plate prints by object. clear removes keys. Custom G-code cannot be set per object. In the open app, linked copies share these overrides and the response includes effective object and part values; use app_object_settings_set to edit a named part.',
    input: z.object({ object: objectArg, set: settingsArg.default({}), clear: z.array(z.string()).default([]) }),
    title: (i) => `Change ${Object.keys(i.set).length + i.clear.length} settings of ${i.object}?`,
    run(i, project) {
      checkSettings(deps, i.set)
      const settings = project.setOwnSettings(i.object, i.set as Record<string, SettingValue>, i.clear)
      return done(`${i.object}: ${Object.keys(settings).length} settings of its own`, project, { settings })
    },
  })

  const addVolume = tool({
    name: 'project.add_volume',
    description:
      'Add a volume to an object, in the object\'s own coordinates (as modeled, before rotation and scale; slicerx_project_show gives each object\'s model_bounds): negative cuts it away, support_blocker keeps support out, support_enforcer asks for support there (with supports on), and modifier prints the object inside it with its own settings (walls, infill, speeds, flow). The shape is a box, an upright cylinder, or an STL model, centered at center (default the object\'s center).',
    input: z.object({
      object: objectArg,
      role: z.enum(['negative', 'support_blocker', 'support_enforcer', 'modifier']),
      shape: z.union([
        z.object({ box: vec3.describe('Size in mm, X, Y and Z') }),
        z.object({ cylinder: z.object({ diameter: z.number().positive(), height: z.number().positive() }) }),
        z.object({ model: z.string().min(1).describe('Absolute path of an STL file in an allowed folder') }),
      ]),
      center: vec3.optional().describe('Center in the object\'s own coordinates, mm'),
      settings: settingsArg.optional().describe('For a modifier: the settings inside it'),
      name: z.string().min(1).max(80).optional(),
    }),
    title: (i) => `Add a ${i.role.replace('_', ' ')} to ${i.object}?`,
    async run(i, project) {
      if (i.settings && i.role !== 'modifier') throw new ToolInputError('Only a modifier carries settings.')
      if (i.role === 'modifier' && !i.settings) throw new ToolInputError('A modifier needs settings to print with.')
      if (i.settings) checkSettings(deps, i.settings)
      const bounds = project.modelBounds(i.object)
      const center = i.center ?? ([0, 1, 2].map((k) => ((bounds.min[k] ?? 0) + (bounds.max[k] ?? 0)) / 2) as [number, number, number])
      let positions: Float32Array
      let shape: string
      const at = `at [${center.map((v) => Math.round(v * 100) / 100).join(', ')}]`
      if ('box' in i.shape) {
        positions = boxPositions(i.shape.box, center)
        shape = `box ${i.shape.box.join(' x ')} mm ${at}`
      } else if ('cylinder' in i.shape) {
        positions = cylinderPositions(i.shape.cylinder.diameter, i.shape.cylinder.height, center)
        shape = `cylinder ${i.shape.cylinder.diameter} mm across, ${i.shape.cylinder.height} mm tall, ${at}`
      } else {
        const path = await resolveModel(deps.policy, i.shape.model)
        const raw = readStlPositions(readFileSync(path))
        const st = meshStats(raw)
        const mid = [0, 1, 2].map((k) => (st.minMm[k] ?? 0) + (st.bboxMm[k] ?? 0) / 2)
        positions = transformPositions(raw, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, center[0] - (mid[0] ?? 0), center[1] - (mid[1] ?? 0), center[2] - (mid[2] ?? 0), 1])
        shape = `${path.split(/[\\/]/).pop()} ${at}`
      }
      const name = i.name ?? `${i.role.replace('_', ' ')} ${shape.split(' ')[0]}`
      const handle = await deps.slicer.loadParts(name, [{ name, slot: 1, positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, k) => k) }])
      const volume = project.addHeldVolume(i.object, { name, role: i.role as VolumeRole, meshId: handle.id, shape, ...(i.settings ? { settings: i.settings as Record<string, SettingValue> } : {}) })
      return done(`${volume.id}: ${i.role.replace('_', ' ')} ${shape}`, project, { volume: { id: volume.id, name, role: i.role, shape }, model_bounds: bounds })
    },
  })

  const removeVolume = tool({
    name: 'project.remove_volume',
    description: 'Remove a volume (a cut, support region or modifier) from an object, by the id slicerx_project_add_volume gave it.',
    input: z.object({ object: objectArg, volume: z.string().min(1) }),
    title: (i) => `Remove ${i.volume} from ${i.object}?`,
    run(i, project) {
      project.removeVolume(i.object, i.volume)
      return done(`${i.volume} removed`, project)
    },
  })

  const heightRanges = tool({
    name: 'project.height_ranges',
    description: `Set the project's settings by height (replaces the list; an empty list clears it): each range has z_from_mm and z_to_mm above the bed, the settings, and optionally the objects it is for (every object when left out). A range can change ${RANGE_KEYS.join(', ')}. Objects printed layer by layer share the nozzle, so temperature, pressure advance and retraction then apply to the whole layer.`,
    input: z.object({
      ranges: z
        .array(z.object({ z_from_mm: z.number().min(0), z_to_mm: z.number().positive(), settings: settingsArg, objects: z.array(objectArg).optional() }))
        .max(64),
    }),
    title: (i) => (i.ranges.length ? `Set ${i.ranges.length} height ranges?` : 'Clear the height ranges?'),
    run(i, project) {
      for (const r of i.ranges) {
        if (!(r.z_to_mm > r.z_from_mm)) throw new ToolInputError(`A range must end above where it starts (${r.z_from_mm} to ${r.z_to_mm} mm).`)
        if (Object.keys(r.settings).length === 0) throw new ToolInputError('Each range needs at least one setting.')
        checkSettings(deps, r.settings, RANGE_KEYS)
      }
      project.setHeightRanges(i.ranges.map((r) => ({ zFromMm: r.z_from_mm, zToMm: r.z_to_mm, settings: r.settings as Record<string, SettingValue>, ...(r.objects ? { objects: r.objects } : {}) })))
      return done(i.ranges.length ? `${i.ranges.length} height ranges` : 'No height ranges', project)
    },
  })

  const plateAdd = tool({
    name: 'project.plate_add',
    description: 'Add an empty plate to the project and answer with its number. Fill it with slicerx_project_move_to_plate.',
    input: z.object({}),
    title: () => 'Add a plate?',
    run(_i, project) {
      const index = project.addPlate()
      return done(`Plate ${index} added`, project, { plate: index })
    },
  })

  const plateRemove = tool({
    name: 'project.plate_remove',
    description: 'Remove a plate. A plate with objects needs move_to, the plate they go to. Plates after it move up one number.',
    input: z.object({ plate: z.number().int().min(1), move_to: z.number().int().min(1).optional() }),
    title: (i) => `Remove plate ${i.plate}?`,
    run(i, project) {
      project.removePlate(i.plate, i.move_to)
      return done(`Plate ${i.plate} removed`, project)
    },
  })

  const moveToPlate = tool({
    name: 'project.move_to_plate',
    description: 'Move an object, with all its copies, to another plate.',
    input: z.object({ object: objectArg, plate: z.number().int().min(1) }),
    title: (i) => `Move ${i.object} to plate ${i.plate}?`,
    run(i, project) {
      project.moveToPlate(i.object, i.plate)
      return done(`${i.object} on plate ${i.plate}`, project)
    },
  })

  const removeObject = tool({
    name: 'project.remove_object',
    description: 'Take an object, with all its copies, out of the project.',
    input: z.object({ object: objectArg }),
    title: (i) => `Remove ${i.object}?`,
    run(i, project) {
      project.removeObject(i.object)
      return done(`${i.object} removed`, project)
    },
  })

  const duplicate = tool({
    name: 'project.duplicate',
    description:
      'Duplicate an object, as Duplicate does in the app: each copy is a new object of its own (its own id, to move, turn or give settings separately) with the same model, rotation, scale, settings and volumes, on the same plates, in the automatic rows. For identical copies that always print alike, add the model with copies instead. Answers with the new ids and the project.',
    input: z.object({ object: objectArg, count: z.number().int().min(1).max(50).default(1).describe('How many copies, 1 to 50') }),
    title: (i) => `Duplicate ${i.object}${i.count > 1 ? ` ${i.count} times` : ''}?`,
    run(i, project) {
      const ids = project.duplicate(i.object, i.count)
      return done(`${i.object} duplicated as ${ids.join(', ')}`, project, { objects: ids })
    },
  })

  const rename = tool({
    name: 'project.rename',
    description: 'Rename an object. Its id stays, and the new name shows in the app and in the exported project.',
    input: z.object({ object: objectArg, name: z.string().min(1).max(120) }),
    title: (i) => `Rename ${i.object} to ${i.name}?`,
    run(i, project) {
      const id = project.rename(i.object, i.name)
      return done(`${id} is now ${i.name.trim()}`, project)
    },
  })

  const layOnFace = tool({
    name: 'project.lay_on_face',
    description:
      'Lay an object on one of its faces, as Lay on bed does in the app: it turns so that face points straight down and sits on the bed. normal is the face\'s outward normal in the model as modeled, as slicerx_geom_faces gives it for the same model file (for example [1, 0, 0] lays it on its +x side). It sets the rotation (absolute, as slicerx_project_rotate does) and keeps the scale. Answers with the project, including the rotation and the new size.',
    input: z.object({ object: objectArg, normal: vec3.describe('Outward normal of the face, in the model as modeled') }),
    title: (i) => `Lay ${i.object} on a face?`,
    run(i, project) {
      const pose = project.pose(i.object)
      const rotate = downRotation(i.normal, pose.scale)
      project.setRotation(pose.id, rotate)
      return done(`${pose.id} laid on its face, rotated to ${rotate.join(', ')} deg`, project, { rotate })
    },
  })

  const lock = tool({
    name: 'project.lock',
    description:
      'Lock or unlock an object, as Lock on the app\'s ring menu does: a locked object is not moved, rotated, scaled, laid on a face, centered, cut or taken to another plate (those tools refuse it), and an arrange leaves it on its plate. Answers with the project, whose objects say locked.',
    input: z.object({ object: objectArg, locked: z.boolean().default(true).describe('true locks it, false unlocks it') }),
    title: (i) => `${i.locked ? 'Lock' : 'Unlock'} ${i.object}?`,
    run(i, project) {
      const id = project.setLocked(i.object, i.locked)
      return done(`${id} ${i.locked ? 'locked' : 'unlocked'}`, project)
    },
  })

  const printable = tool({
    name: 'project.printable',
    description:
      'Leave an object out of the print, or put it back, as Leave out of the print does in the app: it keeps its place on the plate (its placements say printable: false), and the next slice leaves it out. Answers with the project, whose objects say printable.',
    input: z.object({ object: objectArg, printable: z.boolean().describe('false leaves it out of the print, true puts it back') }),
    title: (i) => (i.printable ? `Print ${i.object}?` : `Leave ${i.object} out of the print?`),
    run(i, project) {
      const id = project.setPrintable(i.object, i.printable)
      return done(i.printable ? `${id} is in the print` : `${id} is left out of the print`, project)
    },
  })

  const center = tool({
    name: 'project.center',
    description:
      'Center an object on the bed of its plate, as Center on the bed does in the app: the center of its footprint goes to the middle of the printable area (the circle\'s center on a round bed), and it stays there as if placed with slicerx_project_move. Answers with the position and the project.',
    input: z.object({ object: objectArg }),
    title: (i) => `Center ${i.object} on the bed?`,
    run(i, project) {
      const { id, position } = project.center(i.object)
      return done(`${id} centered at ${position.join(', ')} mm`, project, { position })
    },
  })

  const splitObjects = tool({
    name: 'project.split_objects',
    description:
      'Split an object to objects, as Split to objects does in the app: each separate body of its model becomes an object of its own, named after it with a number, with its rotation, scale, settings, volumes, lock and print state, on the same plates; one placed with slicerx_project_move leaves each piece where it was. The source object goes. Answers with the new ids and the project.',
    input: z.object({ object: objectArg }),
    title: (i) => `Split ${i.object} to objects?`,
    async run(i, project) {
      const ids = await project.splitObjects(i.object)
      return done(`${i.object} split to ${ids.length} objects: ${ids.join(', ')}`, project, { objects: ids })
    },
  })

  const splitParts = tool({
    name: 'project.split_parts',
    description:
      'Split an object to parts, as Split to parts does in the app: each separate body of its model becomes a part of the same object, which keeps its id, place, rotation, scale and settings. Answers with the part count and the project, whose object lists parts.',
    input: z.object({ object: objectArg }),
    title: (i) => `Split ${i.object} to parts?`,
    async run(i, project) {
      const { id, parts } = await project.splitParts(i.object)
      return done(`${id} split to ${parts} parts`, project, { parts })
    },
  })

  return [move, rotate, scale, objectSettings, addVolume, removeVolume, heightRanges, plateAdd, plateRemove, moveToPlate, removeObject, duplicate, rename, layOnFace, lock, printable, center, splitObjects, splitParts] as PilotTool<never>[]
}
