// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds the showcase X with the app's own CAD tools, in the web app, and writes it to packages/core/bench/models:
//   x-mark-showcase.sx3mf         the editable source, one object with its CAD history
//   x-mark-showcase.stl           the same body
//   x-mark-showcase-2color.3mf    one object of two parts: the X on filament 1, the plinth on filament 2
//
// The history: a rectangle sketch extruded 6 mm (the plinth), its top and corner edges filleted 2 mm, the X outline
// sketched upright and extruded 8 mm each way joined onto it (the union), and the X's front and back edges filleted
// 1.2 mm. Rounds at a 0.001 mm chord tolerance, about 5 degrees a facet.
//
//   pnpm --filter @slicerx/web exec vite --port 4398      (with SLICERX_E2E=1)
//   node apps/web/scripts/build-showcase-x.mjs http://127.0.0.1:4398/studio/
import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const OUT = resolve(ROOT, 'packages/core/bench/models')
const URL0 = process.argv[2] ?? 'http://127.0.0.1:4398/studio/'

// The X mark's outline (generate.py's MARK), 80 mm tall standing on the 6 mm plinth.
const MARK = [[4.5, 4.0], [10.7, 4.0], [16.0, 12.1], [21.3, 4.0], [27.5, 4.0], [19.2, 16.0], [27.5, 28.0], [21.3, 28.0], [16.0, 19.9], [10.7, 28.0], [4.5, 28.0], [12.8, 16.0]]
const HEIGHT = 80
const HALF_T = 8
const PLINTH_H = 6
const PLINTH_R = 2
const ROUND = 1.2
const TOL = 0.001
// Only filament keys, so opening a file never asks about a project's printer, process or G-code.
const FILAMENTS = { filament_colour: ['#26A69A', '#F2EFE6'], filament_type: ['PLA', 'PLA'], filament_settings_id: ['Generic PLA @System', 'Generic PLA @System'] }

const s = HEIGHT / 24
let outline = MARK.map(([px, py]) => [(px - 16) * s, PLINTH_H + (28 - py) * s])
const area = outline.reduce((a, p, i) => { const q = outline[(i + 1) % outline.length]; return a + p[0] * q[1] - q[0] * p[1] }, 0)
if (area < 0) outline = outline.reverse()
const halfX = Math.max(...outline.map((p) => Math.abs(p[0])))
const plinth = { hx: halfX + 4, hy: HALF_T + 5 }

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal'] })
const page = await b.newPage()
await page.addInitScript(() => {
  if (sessionStorage.getItem('sx-e2e')) return
  sessionStorage.setItem('sx-e2e', '1')
  localStorage.setItem('slicerx.debug', '1')
  localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, autoSlice: false }))
})
await page.goto(URL0)
await page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 180000 })
await page.waitForFunction(() => !!window.__sx, null, { timeout: 60000 })

const made = await page.evaluate(async ({ src, outline, plinth, c }) => {
  const at = (p) => import(/* @vite-ignore */ `${new URL('.', location.href).pathname.replace(/\/$/, '')}/@fs${src}/${p}`)
  const [ops, edges, hist, actions, threemf] = await Promise.all([at('cad/cad-ops.ts'), at('cad/edges.ts'), at('cad/history/ops.ts'), at('export/actions.ts'), at('export/threemf.ts')])
  const store = window.__sx
  let n = 0
  // Meshes stay in the store; nothing is sliced, so the handle is only a name.
  const loader = {
    loadParts: async (name, parts) => {
      const tris = (p) => p.indices.length / 3
      return { id: `showcase-${++n}`, hash: `showcase-${n}`, name, triangles: parts.reduce((t, p) => t + tris(p), 0), bboxMm: [0, 0, 0], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: tris(p) })) }
    },
  }
  store.setState({ plate: [], selection: null, selectedIds: [] })
  const bed = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
  const upright = { origin: [0, 0, 0], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }
  const { hx, hy } = plinth
  const corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]
  const sides = [[0, -1], [1, 0], [0, 1], [-1, 0]]
  // The plinth's top edges and its four upright corners: rounded with sphere corners; the bottom stays sharp.
  const plinthEdges = corners.flatMap(([x, y], i) => {
    const [x2, y2] = corners[(i + 1) % 4]
    return [
      { a: [x, y, c.PLINTH_H], b: [x2, y2, c.PLINTH_H], face: [0, 0, 1] },
      { a: [x, y, 0], b: [x, y, c.PLINTH_H], face: [sides[i][0], sides[i][1], 0] },
    ]
  })
  // The X's front and back edges, all but the ones along its foot.
  const xEdges = outline.flatMap((p, i) => {
    const q = outline[(i + 1) % outline.length]
    if (Math.abs(p[1] - c.PLINTH_H) < 1e-9 && Math.abs(q[1] - c.PLINTH_H) < 1e-9) return []
    return [
      { a: [p[0], -c.HALF_T, p[1]], b: [q[0], -c.HALF_T, q[1]], face: [0, -1, 0] },
      { a: [p[0], c.HALF_T, p[1]], b: [q[0], c.HALF_T, q[1]], face: [0, 1, 0] },
    ]
  })
  const fillet = (list, r) => ({ op: 'edge.fillet', edges: list, radiusMm: r, toleranceMm: c.TOL })
  const last = () => store.getState().plate.at(-1)
  const sketch = (points) => ({ type: 'sketch', loops: [{ points }] })

  // One object, the union, with its history.
  await ops.applyExtrude(loader, { frame: bed, shape: sketch(corners), spec: { distanceMm: c.PLINTH_H, operation: 'new' }, name: 'X mark' })
  const id = last().id
  await edges.applyEdges(loader, id, 0, fillet(plinthEdges, c.PLINTH_R))
  await ops.applyExtrude(loader, { frame: upright, shape: sketch(outline), spec: { distanceMm: c.HALF_T, extent: 'symmetric', operation: 'join' }, target: { objectId: id, partIndex: 0 }, name: 'X' })
  await edges.applyEdges(loader, id, 0, fillet(xEdges, c.ROUND))
  // The tools' first run rounds at the default tolerance; the replay runs every step as recorded, at c.TOL.
  const whole = store.getState().plate.find((e) => e.id === id)
  const status = (await hist.applyHistory(loader, id, whole.history)).status

  // The two parts for the 2-colour file: the plinth and the X on its own, from the same steps.
  await ops.applyExtrude(loader, { frame: bed, shape: sketch(corners), spec: { distanceMm: c.PLINTH_H, operation: 'new' }, name: 'Plinth' })
  const pid = last().id
  await edges.applyEdges(loader, pid, 0, fillet(plinthEdges, c.PLINTH_R))
  await hist.applyHistory(loader, pid, store.getState().plate.find((e) => e.id === pid).history)
  await ops.applyExtrude(loader, { frame: upright, shape: sketch(outline), spec: { distanceMm: c.HALF_T, extent: 'symmetric', operation: 'new' }, name: 'X' })
  const xid = last().id
  await edges.applyEdges(loader, xid, 0, fillet(xEdges, c.ROUND))
  await hist.applyHistory(loader, xid, store.getState().plate.find((e) => e.id === xid).history)

  const plate = store.getState().plate
  const one = plate.find((e) => e.id === id)
  const p = plate.find((e) => e.id === pid)
  const x = plate.find((e) => e.id === xid)
  // The source project: the union object alone.
  store.setState({ plate: [one], selection: one.id, selectedIds: [one.id] })
  const sx3mf = await actions.sx3mfBytes(actions.allPlates ? actions.allPlates() : (await at('plate/plates.ts')).allPlates(), { settings: c.FILAMENTS })
  // The 2-colour file: one object, the X on slot 1 and the plinth on slot 2, both in the X's frame.
  const world = (e, part) => {
    const t = e.transform
    const pos = new Float32Array(part.positions.length)
    for (let i = 0; i < pos.length; i += 3) {
      const [px, py, pz] = [part.positions[i], part.positions[i + 1], part.positions[i + 2]]
      pos[i] = t[0] * px + t[4] * py + t[8] * pz + t[12]
      pos[i + 1] = t[1] * px + t[5] * py + t[9] * pz + t[13]
      pos[i + 2] = t[2] * px + t[6] * py + t[10] * pz + t[14]
    }
    return pos
  }
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const two = {
    id: 'two', name: 'X mark', handle: { id: 'two', name: 'X mark' }, transform: ident, colors: c.FILAMENTS.filament_colour,
    parts: [
      { name: 'X', slot: 1, positions: world(x, x.parts[0]), indices: x.parts[0].indices },
      { name: 'Plinth', slot: 2, positions: world(p, p.parts[0]), indices: p.parts[0].indices },
    ],
  }
  const meta = store.getState().plates.find((m) => m.id === store.getState().activePlate)
  const twoColor = await threemf.writeProjectCompressed({ plates: [{ ...meta, objects: [two] }], bed: store.getState().bed, settings: c.FILAMENTS })
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s) }
  return {
    status: status.map((x) => x.state + (x.message ? `: ${x.message}` : '')),
    steps: one.history.steps.map((s) => s.params.op),
    sx3mf: b64(sx3mf),
    twoColor: b64(twoColor),
    body: { positions: Array.from(world(one, one.parts[0])), indices: Array.from(one.parts[0].indices) },
  }
}, { src: resolve(ROOT, 'packages/app/src'), outline, plinth, c: { HALF_T, PLINTH_H, PLINTH_R, ROUND, TOL, FILAMENTS } })
await b.close()

console.log('steps', made.steps.join(', '), '|', made.status.join(', '))
if (made.status.some((x) => !x.startsWith('done'))) process.exit(1)
writeFileSync(resolve(OUT, 'x-mark-showcase.sx3mf'), Buffer.from(made.sx3mf, 'base64'))
writeFileSync(resolve(OUT, 'x-mark-showcase-2color.3mf'), Buffer.from(made.twoColor, 'base64'))
// Binary STL of the body, normals from the winding.
const { positions: P, indices: I } = made.body
const stl = Buffer.alloc(84 + (I.length / 3) * 50)
stl.write('SlicerX X mark showcase model, Apache-2.0'.padEnd(80, ' '), 0, 'latin1')
stl.writeUInt32LE(I.length / 3, 80)
for (let t = 0, o = 84; t < I.length; t += 3, o += 50) {
  const v = [0, 1, 2].map((k) => [P[3 * I[t + k]], P[3 * I[t + k] + 1], P[3 * I[t + k] + 2]])
  const u = v[1].map((x, k) => x - v[0][k])
  const w = v[2].map((x, k) => x - v[0][k])
  const nrm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
  const l = Math.hypot(...nrm) || 1
  ;[...nrm.map((x) => x / l), ...v.flat()].forEach((x, k) => stl.writeFloatLE(x, o + 4 * k))
}
writeFileSync(resolve(OUT, 'x-mark-showcase.stl'), stl)
console.log('wrote', ['x-mark-showcase.sx3mf', 'x-mark-showcase.stl', 'x-mark-showcase-2color.3mf'].join(', '))
