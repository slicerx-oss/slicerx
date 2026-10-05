// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// text_to_part: build a simple functional part from a parametric spec the
// model writes (plates, boxes, cylinders, L brackets, through holes), add it
// to the project on its own plate and report its size and volume for review.
// Uses sx-geom `build` when the host has it; otherwise meshes the solids here
// as separate closed shells and cuts holes with `subtract` if that exists.
import type { Cell, MeshPart } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill, type ToolContext } from '../../src/tool'
import { partsBox } from '../orientation_search/geometry'
import { cm3, densityOf, fmtSize, geomRun, geomTry, meshInfo, meshVolume, needsGeometry, num, partFromGeom, printNumbers, rec, round, toGeomMesh, triangleCount, type GeomMesh, type GeomSolid } from '../geom_common/index'
import { HoleSpecInput, ProfileSpec, SolidSpec, buildSolids, planHoles, primMesh, primitives, profileRequest } from './solids'

/**
 * The solids joined into one manifold body with the holes cut out, through sx-geom `boolean`. Null when
 * this engine has no `boolean`, so the caller falls back to `build`.
 */
export async function unitedBody(ctx: ToolContext, solids: GeomSolid[], holes: GeomSolid[]): Promise<Record<string, unknown> | null> {
  const mesh = async (s: GeomSolid) => (await geomRun(ctx, 'build', { solids: [s] }))['mesh']
  const bodies = await Promise.all(solids.map(mesh))
  const [first, ...rest] = bodies
  if (first === undefined) return null
  let body: Record<string, unknown> | null = rest.length ? await geomTry(ctx, 'boolean', { op: 'union', a: [first], b: rest }) : { mesh: first, shells: 1 }
  if (!body) return null
  if (holes.length) body = await geomTry(ctx, 'boolean', { op: 'difference', a: [body['mesh']], b: await Promise.all(holes.map(mesh)) })
  return body
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'part'
}

export function createTextToPart() {
  return defineSkill({
    name: 'text_to_part',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Make a simple functional part from a description by writing it as parametric solids: plates and boxes (size and minimum corner), cylinders (diameter, height, base center, axis) and L brackets (two legs, width, thickness), plus through holes (diameter, a point on the axis, axis, optional countersink). For outlines boxes cannot make (rounded ends, hooks, gussets, cams, a D shape) add profiles: closed loops of points, lines, arcs and circles extruded up along Z, with inner loops as holes. Solids and profiles are joined into one body. Units are mm, Z up, the bed at Z 0. Adds the part to the project on a new plate and reports its size and volume for the user to review before slicing. Holes are cut only when the geometry engine can; otherwise the output says they are missing.',
    input: z.object({
      name: z.string().min(1).max(60).describe('Short part name, such as "L bracket 40 mm"'),
      solids: z.array(SolidSpec).max(24).default([]),
      profiles: z.array(ProfileSpec).max(8).default([]).describe('Extruded outlines, joined to the solids'),
      holes: z.array(HoleSpecInput).max(24).default([]),
      material: z.string().optional().describe('Filament for the weight estimate; default the loaded material'),
    }),
    args: (i) => [`"${i.name}"`, `--solids ${i.solids.map((s) => s.type).join(',')}`, i.profiles.length ? `--profiles ${i.profiles.length}` : null, i.holes.length ? `--holes ${i.holes.map((h) => h.diameterMm).join(',')}` : null].filter(Boolean).join(' '),
    async approval(i) {
      return { title: `Add "${i.name}" to the project?`, lines: [`${i.solids.length} solid${i.solids.length === 1 ? '' : 's'}${i.profiles.length ? `, ${i.profiles.length} profile${i.profiles.length === 1 ? '' : 's'}` : ''}${i.holes.length ? `, ${i.holes.length} hole${i.holes.length === 1 ? '' : 's'}` : ''}, on a new plate`], actions: [] }
    },
    async run(i, ctx) {
      const project = ctx.project
      if (!project?.addObject) return { ok: false, summary: 'This project cannot take new objects' }
      if (i.solids.length === 0 && i.profiles.length === 0) return { ok: false, summary: 'Describe the part with at least one solid or profile' }
      if (i.profiles.length && !ctx.host.geom) return needsGeometry('A part with profiles')
      const prims = primitives(i.solids)
      const bad = prims.find((p) => (p.kind === 'box' ? p.max.some((x, k) => x - (p.min[k] ?? 0) <= 0) : p.r <= 0 || p.h <= 0))
      if (bad) return { ok: false, summary: 'Every solid needs a positive size' }
      const planned = planHoles(prims, i.holes)
      const solids = planned.map((p) => p.solid).filter((s): s is GeomSolid => s !== null)
      const missed = planned.filter((p) => p.solid === null)
      const notes: string[] = missed.map((m) => `The ${m.hole.diameterMm} mm hole at ${m.hole.atMm.join(', ')} along ${m.hole.axis} does not pass through any solid, so it was left out.`)
      let part: MeshPart | null = null
      let holesMade = false
      let method = 'meshed here'
      let reportedShells: number | null = null
      if (ctx.host.geom && prims.length) {
        // One body through booleans when the engine has them: `build` only stacks solids, so touching
        // or overlapping ones share edges and the mesh is not manifold.
        const built = (await unitedBody(ctx, buildSolids(prims), solids)) ?? (await geomTry(ctx, 'build', { solids: buildSolids(prims), ...(solids.length ? { subtract: solids } : {}) }))
        if (built) {
          part = partFromGeom(built['mesh'], i.name, 1)
          holesMade = part !== null && solids.length > 0
          method = 'geometry build'
          reportedShells = num(built['shells'], NaN)
          if (!Number.isFinite(reportedShells)) reportedShells = null
        }
      }
      if (!part && prims.length) {
        part = primMesh(prims, i.name)
        method = 'meshed here'
        if (solids.length && ctx.host.geom) {
          const cut = await geomTry(ctx, 'subtract', { mesh: toGeomMesh([part]), solids })
          const next = cut ? partFromGeom(cut['mesh'], i.name, 1) : null
          if (next) {
            part = next
            holesMade = true
          }
        }
      }
      // Profiles: each outline extruded through the engine's sketch path, then everything joined into one body.
      if (i.profiles.length) {
        const bodies: GeomMesh[] = []
        for (const [k, p] of i.profiles.entries()) {
          let r: Record<string, unknown>
          try {
            r = await geomRun(ctx, 'shape.extrude', profileRequest(p))
          } catch (e) {
            return { ok: false, summary: `Profile ${k + 1}: ${(e instanceof Error ? e.message : String(e)).replace(/^sx-geom [a-z.]+: /, '')}` }
          }
          const m = partFromGeom(r['mesh'], i.name, 1)
          if (!m) return { ok: false, summary: `Profile ${k + 1} made no solid` }
          bodies.push(toGeomMesh([m]))
        }
        const [first, ...rest] = part ? [toGeomMesh([part]), ...bodies] : bodies
        const joined = rest.length ? await geomRun(ctx, 'boolean', { op: 'union', a: [first], b: rest }) : { mesh: first }
        part = partFromGeom(joined['mesh'], i.name, 1)
        if (!part) return { ok: false, summary: 'Joining the profiles left no mesh' }
        method = prims.length ? `${method}, profiles joined` : 'profiles'
        reportedShells = num(rec(joined)['shells'], NaN)
        if (!Number.isFinite(reportedShells)) reportedShells = null
      }
      if (!part) return { ok: false, summary: 'The part came out empty' }
      if (solids.length && !holesMade) notes.push(`The ${solids.length} hole${solids.length === 1 ? ' was' : 's were'} not cut: ${ctx.host.geom ? 'this geometry build cannot subtract solids yet' : 'there is no geometry engine on this host'}. The part has no holes; drill them or add them in a CAD tool.`)
      const info = ctx.host.geom ? await meshInfo(ctx, toGeomMesh([part])) : null
      const box = partsBox([part])
      const size = info?.sizeMm ?? ([round(box.size[0], 2), round(box.size[1], 2), round(box.size[2], 2)] as [number, number, number])
      const volume = info?.volumeMm3 ?? meshVolume([part])
      const shells = reportedShells ?? info?.components ?? prims.length
      if (shells > 1) notes.push(`The part is ${shells} separate closed solids that touch or overlap. Slicers merge them when slicing; a CAD export would keep them apart.`)
      if (info && !info.watertight && shells <= 1) notes.push(`The mesh has ${info.openEdges} open edges; repair the mesh before slicing.`)
      if (box.min[2] < -1e-6) notes.push('Part of the model is below the bed; the slicer drops it onto the bed.')
      const nums = printNumbers(ctx)
      const dens = densityOf(ctx.kb, i.material ?? nums.material)
      const taken = new Set(project.objects().map((o) => o.id))
      let id = slug(i.name)
      for (let k = 2; taken.has(id); k++) id = `${slug(i.name)}-${k}`
      await project.addObject({ id, name: i.name, bboxMm: size, triangles: triangleCount([part]) }, [part])
      const grams = round((volume / 1000) * dens.gPerCm3, 1)
      const rows: [string, Cell][] = [
        ['part', i.name],
        ['size', fmtSize(size)],
        ['volume', `${cm3(volume)} cm3 (${grams} g if solid)`],
        ['solids', `${prims.length}${i.profiles.length ? ` and ${i.profiles.length} profile${i.profiles.length === 1 ? '' : 's'}` : ''} (${method})`],
        ['holes', i.holes.length === 0 ? 'none' : holesMade ? { text: `${solids.length} cut`, tone: 'ok' } : { text: `${solids.length} not cut`, tone: 'warn' }],
        ['review', 'Check the size and holes in the viewport before slicing.'],
      ]
      return {
        summary: `Added ${i.name}, ${fmtSize(size)}, ${cm3(volume)} cm3${i.holes.length ? holesMade ? `, ${solids.length} hole${solids.length === 1 ? '' : 's'}` : ', holes not cut' : ''}`,
        output: {
          objectId: id,
          sizeMm: size,
          volumeCm3: cm3(volume),
          gramsIfSolid: grams,
          solids: prims.length,
          shells,
          holes: planned.map((p) => ({ diameterMm: p.hole.diameterMm, atMm: p.hole.atMm, axis: p.hole.axis, lengthMm: p.lengthMm, cut: holesMade && p.solid !== null, ...(p.hole.countersinkMm ? { countersinkMm: p.hole.countersinkMm } : {}) })),
          holesCut: holesMade,
          method,
          ...(info ? { watertight: info.watertight } : {}),
          ...(notes.length ? { notes } : {}),
        },
        display: [{ kind: 'kv', rows }, ...(notes.length ? [{ kind: 'text' as const, text: notes.join(' ') }] : [])],
        ...(dens.fromKb ? { citations: ctx.kb.cite(dens.sources) } : {}),
      }
    },
  })
}
