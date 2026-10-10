// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object through the integrator path: a multi-object 3MF sliced with print_sequence "by object", read back
// as G-code. Each object must finish before the next starts, the nozzle must clear what is already printed before it
// travels on, and a plate the toolhead or gantry would hit must be refused with a stable error code. A plate only closer
// than the profile's clearance radius, where the head itself clears, slices.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, text } from './helpers'

type Err = { error: { code: string; message: string } }

interface Box {
  name: string
  /** Footprint center on the plate and size, mm. */
  x: number
  y: number
  w: number
  d: number
  h: number
}

function boxMesh(b: Box, id: number): string {
  const v: [number, number, number][] = []
  for (let i = 0; i < 8; i++) v.push([i & 1 ? b.w / 2 : -b.w / 2, i & 2 ? b.d / 2 : -b.d / 2, i & 4 ? b.h : 0])
  const faces = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  return `<object id="${id}" name="${b.name}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${faces.map(([a, c, e]) => `<triangle v1="${a}" v2="${c}" v3="${e}"/>`).join('')}</triangles></mesh></object>`
}

/** A Bambu Studio style project: one plate holding every box as its own object. */
function project(path: string, boxes: Box[], opts: { printer: string; settings?: Record<string, unknown>; plateSequence?: string } = { printer: 'Bambu Lab A1 0.4 nozzle' }): string {
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${boxes.map((b, i) => boxMesh(b, i + 1)).join('')}</resources><build>${boxes.map((b, i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${b.x} ${b.y} 0"/>`).join('')}</build></model>`
  const objects = boxes.map((b, i) => `<object id="${i + 1}"><metadata key="name" value="${b.name}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plate = `<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/>${opts.plateSequence ? `<metadata key="print_sequence" value="${opts.plateSequence}"/>` : ''}${boxes.map((_, i) => `<model_instance><metadata key="object_id" value="${i + 1}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate>`
  writeFileSync(
    path,
    writeZip([
      { name: '3D/3dmodel.model', data: model },
      { name: 'Metadata/model_settings.config', data: `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plate}</config>` },
      { name: 'Metadata/project_settings.config', data: JSON.stringify({ printer_settings_id: opts.printer, ...opts.settings }) },
    ]),
  )
  return path
}

interface Move {
  x: number
  y: number
  z: number
  /** Where the move started. */
  from: [number, number, number]
  extrude: boolean
  line: number
}

/** The moves of a G-code file in absolute coordinates (G90/G91, relative or absolute E). */
function moves(gcode: string): Move[] {
  const out: Move[] = []
  let [x, y, z, e] = [0, 0, 0, 0]
  let rel = false
  let relE = false
  gcode.split('\n').forEach((raw, line) => {
    const t = raw.split(';')[0]!.trim()
    if (t === '') return
    const cmd = t.split(/\s+/)[0]!
    if (cmd === 'G90') rel = false
    else if (cmd === 'G91') rel = true
    else if (cmd === 'M82') relE = false
    else if (cmd === 'M83') relE = true
    else if (cmd === 'G92') {
      const m = /E(-?[\d.]+)/.exec(t)
      if (m) e = Number(m[1])
    }
    if (!['G0', 'G1', 'G2', 'G3'].includes(cmd)) return
    const arg = (k: string): number | undefined => {
      const m = new RegExp(`${k}(-?[\\d.]+)`).exec(t.slice(cmd.length))
      return m ? Number(m[1]) : undefined
    }
    const from: [number, number, number] = [x, y, z]
    const [ax, ay, az, ae] = [arg('X'), arg('Y'), arg('Z'), arg('E')]
    if (ax !== undefined) x = rel ? x + ax : ax
    if (ay !== undefined) y = rel ? y + ay : ay
    if (az !== undefined) z = rel ? z + az : az
    let de = 0
    if (ae !== undefined) {
      de = relE || rel ? ae : ae - e
      e = relE || rel ? e + ae : ae
    }
    if (x !== from[0] || y !== from[1] || z !== from[2]) out.push({ x, y, z, from, extrude: de > 0 && (x !== from[0] || y !== from[1]), line })
  })
  return out
}

type Rect = { x0: number; y0: number; x1: number; y1: number }

const inside = (r: Rect, x: number, y: number, pad = 0) => x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad

/** Whether segment a-b passes through the rectangle (Liang-Barsky). */
function crosses(r: Rect, a: [number, number], b: [number, number]): boolean {
  let [t0, t1] = [0, 1]
  const d = [b[0] - a[0], b[1] - a[1]]
  for (const [p, q] of [[-d[0]!, a[0] - r.x0], [d[0]!, r.x1 - a[0]], [-d[1]!, a[1] - r.y0], [d[1]!, r.y1 - a[1]]] as [number, number][]) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const t = q / p
      if (p < 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
    }
  }
  return t0 < t1
}

interface Printed {
  /** Each object's footprint as printed (from its extrusions) and its top. */
  objects: { rect: Rect; top: number; first: number; last: number }[]
  order: number[]
  moves: Move[]
}

/**
 * Splits the extrusions between the objects by footprint (the boxes are far apart, so every extrusion near a box is
 * that box's), in print order. Extrusions near no box (the purge line) are left out.
 */
function printed(gcode: string, boxes: Box[], shift: [number, number]): Printed {
  const all = moves(gcode)
  const rects = boxes.map((b) => ({ x0: b.x + shift[0] - b.w / 2, y0: b.y + shift[1] - b.d / 2, x1: b.x + shift[0] + b.w / 2, y1: b.y + shift[1] + b.d / 2 }))
  const objects = rects.map((rect) => ({ rect, top: 0, first: -1, last: -1 }))
  const order: number[] = []
  all.forEach((m, i) => {
    if (!m.extrude) return
    const k = rects.findIndex((r) => inside(r, m.x, m.y, 8))
    if (k < 0) return
    const o = objects[k]!
    if (o.first < 0) o.first = i
    o.last = i
    o.top = Math.max(o.top, m.z)
    if (order.at(-1) !== k) order.push(k)
  })
  return { objects, order, moves: all }
}

/** Where the engine put the plate: centered on the bed as a whole, so the shift from the file's coordinates. */
function plateShift(boxes: Box[], bed: number): [number, number] {
  const span = (lo: number[], hi: number[]) => (Math.min(...lo) + Math.max(...hi)) / 2
  return [bed / 2 - span(boxes.map((b) => b.x - b.w / 2), boxes.map((b) => b.x + b.w / 2)), bed / 2 - span(boxes.map((b) => b.y - b.d / 2), boxes.map((b) => b.y + b.d / 2))]
}

/** Checks a by-object G-code file: the order, the lift before each later object, and no travel through a finished one. */
function checkByObject(gcode: string, boxes: Box[], bed: number): { order: string[]; lifts: number[] } {
  const p = printed(gcode, boxes, plateShift(boxes, bed))
  // Each object finishes before the next starts.
  expect(p.order).toHaveLength(boxes.length)
  expect(new Set(p.order).size).toBe(boxes.length)
  const lifts: number[] = []
  for (let n = 1; n < p.order.length; n++) {
    const done = p.order.slice(0, n).map((k) => p.objects[k]!)
    const next = p.objects[p.order[n]!]!
    const tallest = Math.max(...done.map((o) => o.top))
    const prev = done.at(-1)!
    // From the last extrusion of the object before to the first of this one: the nozzle goes up over everything
    // printed so far before any move that leaves the finished object.
    let lift = 0
    for (let i = prev.last + 1; i < next.first; i++) {
      const m = p.moves[i]!
      lift = Math.max(lift, m.z)
      const xy = m.x !== m.from[0] || m.y !== m.from[1]
      if (xy && !inside(prev.rect, m.x, m.y, 8)) expect(m.z, `line ${m.line + 1}: travel toward the next object at z ${m.z}, under the finished ${tallest} mm`).toBeGreaterThan(tallest)
    }
    lifts.push(lift)
    expect(lift).toBeGreaterThan(tallest)
  }
  // From the first extrusion of each later object to the end of the print, no move under a finished object's top
  // passes through its footprint.
  const end = Math.max(...p.objects.map((o) => o.last))
  for (let n = 0; n < p.order.length - 1; n++) {
    const o = p.objects[p.order[n]!]!
    for (let i = p.objects[p.order[n + 1]!]!.first; i <= end; i++) {
      const m = p.moves[i]!
      if (Math.min(m.z, m.from[2]) <= o.top) expect(crosses(o.rect, [m.from[0], m.from[1]], [m.x, m.y]), `line ${m.line + 1} crosses a finished object at z ${m.z}`).toBe(false)
    }
  }
  return { order: p.order.map((k) => boxes[k]!.name), lifts }
}

// Runs only where the core has been built (cargo build -p sx-cli --release), or SLICERX_TEST_SX_BIN names a build.
const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(__dirname, '../../../target/release/sx')
const A1 = ['machine:bambu-a1', 'process:standard']
const A1_MINI = ['machine:bambu-a1-mini', 'process:standard']

describe.skipIf(!existsSync(sxBin))('print by object with the real sx CLI', () => {
  // The A1 and A1 mini keep 40 mm around the nozzle (extruder_clearance_radius), 25 mm under the gantry rod, which
  // sits 56.5 mm behind the nozzle, and their lid is the printable height.
  const three: Box[] = [
    { name: 'tall', x: 60, y: 128, w: 20, d: 20, h: 18 },
    { name: 'short', x: 128, y: 128, w: 20, d: 20, h: 6 },
    { name: 'middle', x: 196, y: 128, w: 20, d: 20, h: 10 },
  ]

  it('prints each object of a 3MF in turn on an A1 and lifts over the tallest finished one', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: project(join(h.dir, 'three.3mf'), three), profiles: A1, overrides: { print_sequence: 'by object' } })
    expect(r.isError, text(r)).toBeFalsy()
    const g = readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8')
    const { order, lifts } = checkByObject(g, three, 256)
    expect(order).toEqual(['tall', 'short', 'middle'])
    // Over the 18 mm box before the short one, and still over it before the middle one.
    expect(lifts[0]).toBeGreaterThan(18)
    expect(lifts[1]).toBeGreaterThan(18)
    // The timelapse and head wrap trips to the bed edge are left out by object (the A1's template), so no layer
    // change runs the nozzle through a finished object.
    expect(g).not.toMatch(/^; don't support timelapse/m)
  })

  it('slices a 3MF saved by object as it was saved, on an A1 mini', async () => {
    // Spread over the 180 mm bed, so they fit only where the file puts them.
    const two: Box[] = [
      { name: 'left', x: 25, y: 90, w: 20, d: 20, h: 15 },
      { name: 'right', x: 155, y: 90, w: 20, d: 20, h: 8 },
    ]
    const h = await connect({ engine: 'sx', sxBin })
    // The print sequence in the project settings, and the plate's own one (Bambu Studio's per plate setting) over a
    // project that prints by layer.
    const saved = [
      project(join(h.dir, 'project.3mf'), two, { printer: 'Bambu Lab A1 mini 0.4 nozzle', settings: { print_sequence: 'by object' } }),
      project(join(h.dir, 'plate.3mf'), two, { printer: 'Bambu Lab A1 mini 0.4 nozzle', settings: { print_sequence: 'by layer' }, plateSequence: 'by object' }),
    ]
    for (const file of saved) {
      const r = await h.call('slicerx_slice_file', { model: file, project_settings: true, profiles: A1_MINI })
      expect(r.isError, text(r)).toBeFalsy()
      const g = readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8')
      expect(checkByObject(g, two, 180).order).toEqual(['left', 'right'])
    }
    const info = await h.call('slicerx_inspect_project', { file: saved[1] })
    expect(data<{ plates: { print_sequence?: string }[] }>(info).plates[0]?.print_sequence).toBe('by object')
    // By layer, the same file interleaves the objects.
    const r = await h.call('slicerx_slice_file', { model: saved[0], project_settings: true, profiles: A1_MINI, overrides: { print_sequence: 'by layer' } })
    expect(r.isError, text(r)).toBeFalsy()
    const p = printed(readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8'), two, plateShift(two, 180))
    expect(p.order.length).toBeGreaterThan(10)
  })

  it('lets a tall object print first when the gantry never passes over it', async () => {
    // 30 mm is over the rod height, but 120 mm apart in y the rod never reaches it while the other prints.
    const apart: Box[] = [
      { name: 'tower', x: 128, y: 50, w: 20, d: 20, h: 30 },
      { name: 'base', x: 128, y: 170, w: 20, d: 20, h: 6 },
    ]
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: project(join(h.dir, 'apart.3mf'), apart), profiles: A1, overrides: { print_sequence: 'by object' } })
    expect(r.isError, text(r)).toBeFalsy()
    expect(checkByObject(readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8'), apart, 256).lifts[0]).toBeGreaterThan(30)
  })

  it('slices objects closer than the clearance radius when the head itself clears them', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    // 30 and 25 mm apart, under the A1's 73 mm radius; the A1 head reaches 21 mm to the side, over 10 mm boxes less.
    for (const [boxes, profiles] of [
      [[{ name: 'Cube A', x: 100, y: 128, w: 20, d: 20, h: 10 }, { name: 'Cube B', x: 150, y: 128, w: 20, d: 20, h: 10 }], A1],
      [[{ name: 'Cube A', x: 50, y: 90, w: 20, d: 20, h: 10 }, { name: 'Cube B', x: 95, y: 90, w: 20, d: 20, h: 10 }], A1_MINI],
    ] as [Box[], string[]][]) {
      const r = await h.call('slicerx_slice_file', { model: project(join(h.dir, 'close.3mf'), boxes), profiles, overrides: { print_sequence: 'by object' } })
      expect(r.isError, text(r)).toBeFalsy()
    }
  })

  it('refuses objects the gantry or the frame would hit with sequence_clearance', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const cases: { boxes: Box[]; profiles: string[]; overrides?: Record<string, unknown>; says: RegExp }[] = [
      // 30 mm tall, printed first, beside the next one: the gantry rod is at 25 mm.
      { boxes: [{ name: 'Tower', x: 60, y: 128, w: 20, d: 20, h: 30 }, { name: 'Base', x: 140, y: 128, w: 20, d: 20, h: 6 }], profiles: A1, says: /The gantry hits Tower\. Tower is 30\.0 mm tall, over the 25\.0 mm the gantry clears/ },
      { boxes: [{ name: 'Tower', x: 40, y: 90, w: 20, d: 20, h: 30 }, { name: 'Base', x: 120, y: 90, w: 20, d: 20, h: 6 }], profiles: A1_MINI, says: /over the 25\.0 mm the gantry clears/ },
      // Far apart in y the lid is the limit.
      { boxes: [{ name: 'Tower', x: 128, y: 50, w: 20, d: 20, h: 30 }, { name: 'Base', x: 128, y: 170, w: 20, d: 20, h: 6 }], profiles: A1, overrides: { extruder_clearance_height_to_lid: 28 }, says: /The frame hits Tower\..*over the 28\.0 mm the frame clears/ },
    ]
    for (const c of cases) {
      const file = project(join(h.dir, 'close.3mf'), c.boxes)
      const r = await h.call('slicerx_slice_file', { model: file, profiles: c.profiles, overrides: { print_sequence: 'by object', ...c.overrides } })
      expect(r.isError).toBe(true)
      const e = data<Err>(r).error
      expect(e.code).toBe('sequence_clearance')
      expect(e.message).toMatch(c.says)
      expect(e.message).toMatch(/printing by object is not safe/i)
      expect(e.message).not.toMatch(/--allow-collisions/)
      // The estimate refuses the same plate, and by layer it slices.
      expect(data<Err>(await h.call('slicerx_estimate_file', { model: file, profiles: c.profiles, overrides: { print_sequence: 'by object', ...c.overrides } })).error.code).toBe('sequence_clearance')
      expect((await h.call('slicerx_estimate_file', { model: file, profiles: c.profiles })).isError).toBeFalsy()
    }
  })

  it('refuses a path into a keep-out zone with collision, in words for a person, and slices it with allow_collisions', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const file = project(join(h.dir, 'keep-out.3mf'), [{ name: 'Cube A', x: 128, y: 128, w: 20, d: 20, h: 8 }])
    // an A1 style nozzle wrap check corner over the cube
    const overrides = { head_wrap_detect_zone: ['0x0', '256x0', '256x256', '0x256'] }
    const r = await h.call('slicerx_slice_file', { model: file, profiles: A1, overrides })
    expect(r.isError, text(r)).toBe(true)
    const e = data<Err & { error: { details?: { collisions?: { kind: string; object?: string }[]; allow_collisions?: boolean } } }>(r).error
    expect(e.code).toBe('collision')
    // sx names a project sliced from its file after the file
    expect(e.message).toMatch(/^Keep-out\.3mf prints into the nozzle wrap check corner on layers? 1/)
    expect(e.message).not.toMatch(/--allow-collisions|sx exited|sx slice/)
    expect(e.details?.collisions?.[0]).toMatchObject({ kind: 'keep_out', zone: 'the nozzle wrap check corner', object: 'keep-out.3mf' })
    expect(e.details?.allow_collisions).toBe(true)
    const ok = await h.call('slicerx_slice_file', { model: file, profiles: A1, overrides, allow_collisions: true })
    expect(ok.isError, text(ok)).toBeFalsy()
  })
})
