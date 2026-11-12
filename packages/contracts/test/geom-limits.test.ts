// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry time limits (src/geom-limits.ts): each operation's class, the three limits, the exact refusal words,
// and every operation the engine lists has a class chosen on purpose.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GEOM_CALL_LIMIT_MS, geomCallLimitMs, geomOpClass, geomStepName, geomStuckMessage, isGeomStuck, isGeomStuckFinal, type GeomOpClass } from '../src/geom-limits'

/** Every operation the engine lists (packages/geom/src/json.rs, ALL_OPERATIONS), with the class it should have. */
const ENGINE: Record<string, GeomOpClass> = {
  info: 'quick',
  render: 'mesh',
  'paint.select': 'quick',
  'paint.regions': 'mesh',
  'paint.texture': 'mesh',
  section: 'quick',
  cut: 'mesh',
  split: 'mesh',
  repair: 'mesh',
  'orient.analyze': 'quick',
  'orient.rank': 'mesh',
  hollow: 'mesh',
  emboss: 'model',
  'emboss.polygons': 'model',
  calibrate: 'mesh',
  resume: 'mesh',
  'layers.plan': 'mesh',
  build: 'model',
  subtract: 'model',
  interference: 'model',
  import: 'mesh',
  simplify: 'mesh',
  remesh: 'mesh',
  'extrude.svg': 'model',
  'text.polygons': 'quick',
  boolean: 'model',
  array: 'model',
  measure: 'quick',
  'measure.feature': 'quick',
  'face.pick': 'quick',
  'shape.profile': 'quick',
  'shape.extrude': 'model',
  'text.mesh': 'model',
  'import.auto': 'mesh',
  'import.selfIntersections': 'mesh',
  'fit.check': 'mesh',
  'face.push': 'model',
  'face.push.preview': 'quick',
  'sketch.check': 'quick',
  'sketch.curves': 'quick',
  'sketch.revolve': 'model',
  'sketch.loft': 'model',
  'sketch.sweep': 'model',
  'sketch.snaps': 'quick',
  'sketch.offset': 'quick',
  'sketch.project': 'quick',
  'dimension.anchor': 'quick',
  'dimension.evaluate': 'quick',
  'edge.pick': 'quick',
  'edge.chamfer': 'model',
  'edge.fillet': 'model',
  'edge.chamfer.preview': 'quick',
  'edge.fillet.preview': 'quick',
  'sketch.fillet': 'quick',
  'sketch.chamfer': 'quick',
  'sketch.solve': 'quick',
  'sketch.svg': 'quick',
  'sketch.trace': 'model',
  'hole.find': 'quick',
  'hole.apply': 'model',
  'thread.find': 'quick',
  'thread.apply': 'model',
  shell: 'model',
  'nest.footprint': 'quick',
  'nest.arrange': 'mesh',
  'nest.start': 'quick',
  'nest.step': 'quick',
  'nest.end': 'quick',
  'format.read3mf': 'mesh',
  'brep.count': 'quick',
  'brep.box': 'model',
  'brep.cylinder': 'model',
  'brep.primitive': 'model',
  'brep.extrude': 'model',
  'brep.boolean': 'model',
  'brep.subtract': 'model',
  'brep.cut': 'model',
  'brep.fillet': 'model',
  'brep.chamfer': 'model',
  'brep.push': 'model',
  'brep.hole': 'model',
  'brep.info': 'quick',
  'brep.tessellate': 'model',
  'brep.save': 'model',
  'brep.load': 'model',
  'brep.free': 'quick',
  'exact.ops': 'quick',
}

/** The operation names in the engine's ALL_OPERATIONS table. */
function engineOps(): string[] {
  const src = readFileSync(join(__dirname, '..', '..', 'geom', 'src', 'json.rs'), 'utf8')
  const table = /const ALL_OPERATIONS: &\[\(&str, &str\)\] = &\[([\s\S]*?)\n\];/.exec(src)?.[1] ?? ''
  return [...table.matchAll(/\("([a-zA-Z0-9.]+)",/g)].map((m) => m[1]!)
}

describe('geometry time limits', () => {
  it('gives every operation the engine lists the class chosen for it, and a name', () => {
    const ops = engineOps()
    expect(ops.length).toBeGreaterThan(80)
    // a new engine operation fails here until it gets a class (and a name) on purpose in src/geom-limits.ts
    expect(ops.filter((op) => !(op in ENGINE))).toEqual([])
    for (const op of ops) {
      expect([op, geomOpClass(op)]).toEqual([op, ENGINE[op]])
      expect([op, geomStepName(op)]).toEqual([op, expect.any(String)])
    }
  })

  it('classes the app worker and history replay steps', () => {
    expect(geomOpClass('engine.core')).toBe('quick')
    expect(geomOpClass('history.replay')).toBe('model')
    expect(geomOpClass('array.merged')).toBe('model')
    expect(geomOpClass('plane.cut')).toBe('mesh')
    expect(geomOpClass('paint')).toBe('mesh')
    // an operation nobody listed is a model call
    expect(geomOpClass('shape.unlisted')).toBe('model')
    expect(geomStepName('shape.unlisted')).toBeUndefined()
  })

  it('has the three limits', () => {
    expect(GEOM_CALL_LIMIT_MS).toEqual({ quick: 30_000, model: 180_000, mesh: 300_000 })
    expect(geomCallLimitMs('measure')).toBe(30_000)
    expect(geomCallLimitMs('array')).toBe(180_000)
    expect(geomCallLimitMs('simplify')).toBe(300_000)
  })

  it('refuses a stopped step by the name a person knows it by, with what to try for its class', () => {
    expect(geomStuckMessage('array', 180_000)).toBe('The step "Array" ran past its 3 min limit and was stopped; try a smaller version: fewer copies or a simpler part')
    expect(geomStuckMessage('format.read3mf', 300_000)).toBe('The step "Project open" ran past its 5 min limit and was stopped; try a smaller version: a coarser mesh')
    expect(geomStuckMessage('measure', 30_000)).toBe('The step "Measure" took too long (over its 30 s limit) and was stopped; try it again')
    expect(geomStuckMessage('edge.fillet', 180_000, 'Fillet 2 mm')).toBe('The step "Fillet 2 mm" ran past its 3 min limit and was stopped; try a smaller version: fewer copies or a simpler part')
    expect(geomStuckMessage('shape.unlisted', 400)).toBe('This step ran past its 0.4 s limit and was stopped; try a smaller version: fewer copies or a simpler part')
    // no engine operation id reaches the words
    expect(geomStuckMessage('paint.texture', 300_000)).not.toMatch(/paint\.texture/)
  })

  it('knows its own refusals, and which of them are final', () => {
    for (const op of ['array', 'repair', 'measure', 'parts.order']) expect(isGeomStuck(`sx-geom ${op}: ${geomStuckMessage(op, geomCallLimitMs(op))}`)).toBe(true)
    // model and mesh work would stop the same way; a quick step is worth asking for again
    expect(['array', 'repair', 'parts.order', 'measure'].map((op) => isGeomStuckFinal(geomStuckMessage(op, geomCallLimitMs(op))))).toEqual([true, true, true, false])
    for (const text of ['boolean: this join is taking too long to finish; try fewer copies or join them in smaller groups', 'The geometry engine was interrupted by a canceled edit. Retry the operation.']) {
      expect(isGeomStuck(text)).toBe(false)
      expect(isGeomStuckFinal(text)).toBe(false)
    }
  })

  it('never shows an operation id or an engine word in a refusal', () => {
    for (const op of [...Object.keys(ENGINE), 'engine.core', 'engine.full', 'history.replay', 'array.merged', 'plane.cut', 'parts.add']) {
      const text = geomStuckMessage(op, geomCallLimitMs(op))
      expect([op, text]).not.toEqual([op, expect.stringMatching(/\b[a-z]+\.[a-zA-Z]+\b|engine|brep|wasm/i)])
    }
    // the engine loading itself is no step a person ran
    expect(geomStuckMessage('engine.core', 30_000)).toBe('This step took too long (over its 30 s limit) and was stopped; try it again')
  })

  it('matches the refusal the MCP change notes quote', () => {
    // the change file folds into the MCP changelog at a release, so read whichever holds it
    const mcp = join(__dirname, '..', '..', 'mcp')
    const file = join(mcp, 'changes', 'geom-call-deadline.md')
    const note = readFileSync(existsSync(file) ? file : join(mcp, 'CHANGELOG.md'), 'utf8')
    expect(note).toContain(`sx-geom array: ${geomStuckMessage('array', 180_000)}`)
    expect(note).toContain(`sx-geom repair: ${geomStuckMessage('repair', 300_000)}`)
  })
})
