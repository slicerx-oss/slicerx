// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir and max-volumetric calibration end to end: plans layer heights with `sx-geom layers.plan`, feeds them to
// `sx slice` as options.layerTopsMm, and checks the G-code against the plan. Also slices the
// same model at a uniform 0.2 mm and prints the print time and stair step difference.
//   node scripts/e2e-smart-layer.mjs [--sx path/to/sx] [--geom path/to/sx-geom] [--json]
// Models: core's x-mark.stl and a procedural dome (cylinder under a hemisphere). Exits 1 on
// the first failed check.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const sx = arg('--sx', join(root, 'target/release/sx'))
const geom = arg('--geom', join(root, 'target/release/sx-geom'))
const asJson = process.argv.includes('--json')
const work = mkdtempSync(join(tmpdir(), 'smart-layer-'))

// A closed dome model as a binary STL: cylinder r 14 mm and 6 mm tall under a hemisphere.
function domeStl() {
  const R = 14, BASE = 6, RINGS = 48, SEG = 96
  const profile = [[0, 0], [R, 0], [R, BASE]]
  for (let i = 1; i <= RINGS; i++) {
    const a = (Math.PI / 2) * (i / RINGS)
    profile.push([R * Math.cos(a), BASE + R * Math.sin(a)])
  }
  const pt = (k, j) => {
    const t = (2 * Math.PI * j) / SEG
    return [profile[k][0] * Math.cos(t), profile[k][0] * Math.sin(t), profile[k][1]]
  }
  const tris = []
  for (let k = 0; k < profile.length - 1; k++) {
    for (let j = 0; j < SEG; j++) {
      const j2 = (j + 1) % SEG
      const [a, b, c, d] = [pt(k, j), pt(k, j2), pt(k + 1, j), pt(k + 1, j2)]
      if (k === 0) tris.push([[0, 0, 0], b, a]) // bottom cap
      else tris.push([a, c, b])
      if (k > 0 || true) tris.push([b, c, d])
    }
  }
  // The top ring collapses to the pole; the last band's second triangle is degenerate.
  const flat = tris.filter(([a, b, c]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) > 1e-9
  })
  const buf = Buffer.alloc(84 + 50 * flat.length)
  buf.writeUInt32LE(flat.length, 80)
  flat.forEach((t, i) => {
    let o = 84 + 50 * i + 12
    for (const p of t) for (const c of p) { buf.writeFloatLE(c, o); o += 4 }
  })
  const path = join(work, 'dome.stl')
  writeFileSync(path, buf)
  return path
}

const models = [
  { name: 'x-mark', path: join(root, 'packages/core/bench/models/x-mark.stl') },
  { name: 'dome', path: domeStl() },
]
const bed = { widthMm: 256, depthMm: 256, heightMm: 250 }
const config = { layer_height: 0.2, wall_loops: 2, sparse_infill_density: 15, brim_width: 3 }

function slice(tag, model, layerTopsMm) {
  const req = {
    schemaVersion: 1,
    meshes: { m: model.path },
    plate: { bed, objects: [{ id: 'o1', name: model.name, mesh: 'm' }] },
    config,
    options: { flavor: 'klipper', ...(layerTopsMm ? { layerTopsMm } : {}) },
  }
  const dir = join(work, tag)
  mkdirSync(dir, { recursive: true })
  const reqPath = join(dir, 'request.json')
  writeFileSync(reqPath, JSON.stringify(req))
  const out = JSON.parse(execFileSync(sx, ['slice', '--request', reqPath, '--out-dir', dir], { maxBuffer: 1 << 28 }).toString())
  return { out, gcode: readFileSync(join(dir, 'slice.gcode'), 'utf8') }
}

const near = (a, b, tol = 2e-3) => Math.abs(a - b) <= tol
// Core may clip the last layer at the model top or keep the planned top.
const planned = (tops, i, top) => (i === tops.length - 1 ? [tops[i], top] : [tops[i]])
const atPlan = (z, tops, i, top) => planned(tops, i, top).some((t) => near(z, t))
const rows = []
for (const model of models) {
  const info = JSON.parse(execFileSync(geom, ['info'], { input: JSON.stringify({ mesh: { stlPath: model.path } }) }).toString())
  const top = info.bounds.max[2]
  const uniform = slice(`${model.name}-uniform`, model)
  for (const mode of ['quality', 'strength']) {
    const plan = JSON.parse(
      execFileSync(geom, ['layers.plan'], {
        input: JSON.stringify({ mesh: { stlPath: model.path }, nozzleMm: 0.4, mode, options: { baseHeightMm: 0.2 } }),
        maxBuffer: 1 << 26,
      }).toString(),
    )
    const tag = `${model.name}-${mode}`
    const { out, gcode } = slice(tag, model, plan.layerTopsMm)
    const tops = plan.layerTopsMm
    // Layer count and heights match the plan. Core clips the last layer at the model top.
    assert.equal(out.layerCount, tops.length, `${tag}: layer count`)
    assert.deepEqual(out.warnings, [], `${tag}: warnings`)
    const zs = [...gcode.matchAll(/^;Z:([\d.]+)$/gm)].map((m) => Number(m[1]))
    const hs = [...gcode.matchAll(/^;HEIGHT:([\d.]+)$/gm)].map((m) => Number(m[1]))
    assert.equal(zs.length, tops.length, `${tag}: ;Z: lines`)
    zs.forEach((z, i) => assert.ok(atPlan(z, tops, i, top), `${tag}: layer ${i} at ${z}, plan ${tops[i]}`))
    out.layerZ.forEach((z, i) => assert.ok(atPlan(z, tops, i, top), `${tag}: result layerZ ${i}`))
    hs.slice(0, -1).forEach((h, i) => assert.ok(near(h, plan.heightsMm[i]), `${tag}: height ${i} is ${h}, plan ${plan.heightsMm[i]}`))
    assert.ok(near(zs[0], 0.2) && zs.at(-1) >= top - 2e-3 && zs.at(-1) <= top + 0.1, `${tag}: first and last layer`)
    for (const h of plan.heightsMm.slice(1)) {
      assert.ok(h >= plan.bounds.minMm - 1e-9 && h <= plan.bounds.maxMm + 1e-9, `${tag}: ${h} outside bounds`)
    }
    // G-code sanity: header, one layer change per layer, finite extrusion, cool-down at the end.
    assert.match(gcode, /^; generated by SlicerX/, `${tag}: header`)
    assert.equal((gcode.match(/^;LAYER_CHANGE$/gm) ?? []).length, tops.length, `${tag}: layer changes`)
    assert.match(gcode, new RegExp(`total layer number: ${tops.length}`), `${tag}: total layer number`)
    assert.ok(!/NaN|Infinity/.test(gcode), `${tag}: non-finite number in G-code`)
    assert.match(gcode.trimEnd().split('\n').slice(-4).join('\n'), /M104 S0/, `${tag}: heater off at the end`)
    assert.ok(out.stats.timeS > 0 && out.stats.filamentMm[0] > 0, `${tag}: stats`)

    const m = plan.metrics
    rows.push({
      model: model.name,
      mode,
      layers: tops.length,
      uniformLayers: uniform.out.layerCount,
      timeS: Math.round(out.stats.timeS),
      uniformTimeS: Math.round(uniform.out.stats.timeS),
      timeChangePct: Math.round((100 * (out.stats.timeS - uniform.out.stats.timeS)) / uniform.out.stats.timeS * 10) / 10,
      meanCuspMm: Math.round(m.meanCuspMm * 1e4) / 1e4,
      uniformMeanCuspMm: Math.round(m.uniformMeanCuspMm * 1e4) / 1e4,
      maxCuspMm: Math.round(m.maxCuspMm * 1e3) / 1e3,
      uniformMaxCuspMm: Math.round(m.uniformMaxCuspMm * 1e3) / 1e3,
      stepChangeMax: Math.round(m.stepChange.max * 1e3) / 1e3,
    })
  }
}
// Max volumetric speed calibration: one outer wall per layer (no vase mode), and the outer wall
// feed rate follows the height bands.
{
  const dir = join(work, 'max-volumetric')
  mkdirSync(dir, { recursive: true })
  const cal = JSON.parse(execFileSync(geom, ['calibrate', '--out-dir', dir], { input: JSON.stringify({ test: 'max-volumetric' }) }).toString())
  const obj = cal.objects[0]
  assert.ok(!('spiral_mode' in obj.settings), 'max-volumetric: no vase mode')
  const req = {
    schemaVersion: 1,
    meshes: { m: resolve(obj.mesh.stlPath) },
    plate: { bed, objects: [{ id: 'o1', name: 'mv', mesh: 'm', settings: obj.settings }] },
    config: {},
    options: { flavor: 'klipper', heightRanges: cal.ranges },
  }
  writeFileSync(join(dir, 'request.json'), JSON.stringify(req))
  const res = JSON.parse(execFileSync(sx, ['slice', '--request', join(dir, 'request.json'), '--out-dir', dir], { maxBuffer: 1 << 28 }).toString())
  const gcode = readFileSync(join(dir, 'slice.gcode'), 'utf8')
  const layers = gcode.split(';LAYER_CHANGE').slice(1)
  const height = cal.expected.heightMm
  assert.ok(res.layerCount === Math.round(height / 0.2), 'max-volumetric: layer count')
  let checked = 0
  layers.forEach((layer, i) => {
    const z = Number(/^;Z:([\d.]+)/m.exec(layer)[1])
    if (i < 3) return // solid base
    const band = cal.ranges.find((r) => r.zFromMm <= z - 0.1 && z - 0.1 < r.zToMm)
    const outer = /;TYPE:Outer wall\n(?:;[^\n]*\n)*G1 F(\d+)/.exec(layer)
    assert.ok(outer, `max-volumetric: layer ${i} has an outer wall`)
    assert.ok(!/;TYPE:Inner wall/.test(layer), `max-volumetric: layer ${i} has one wall`)
    assert.ok(Math.abs(Number(outer[1]) / 60 - band.settings.outer_wall_speed) < 0.1, `max-volumetric: layer ${i} speed ${Number(outer[1]) / 60}`)
    checked++
  })
  assert.ok(checked > 100, 'max-volumetric: bands checked')
  assert.ok(!res.warnings.some((w) => /spiral/.test(w.message)), 'max-volumetric: no spiral warning')
  rows.push({ model: 'max-volumetric tube', mode: 'bands', layers: layers.length, timeS: Math.round(res.stats.timeS) })
}
if (asJson) console.log(JSON.stringify(rows, null, 2))
else {
  console.log('sleipnir against a uniform 0.2 mm slice (0.4 mm nozzle, sx-core, klipper). All checks passed.')
  console.table(rows)
}
