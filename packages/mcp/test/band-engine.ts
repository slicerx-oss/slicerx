// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in engine for a height band on an exact design (paint-exact-band.test.ts, and as sx-geom for the CLI in
// cli-band-paint.test.ts through band-engine-cli.ts): bodies as text, a kernel that splits faces along planes.

interface Face {
  key: number
  lo: number
  hi: number
}
/** A part's row in a paint answer, with the faces it names. */
export type Row = { part: number; faces?: { key: number; state: number; areaMm2: number }[] }

/** The leaf text of a state in a 3MF paint text, for states 1 and 2 (state 1 is 4, state 2 is 8). */
export const leaf = (state: number) => (state << 2).toString(16).toUpperCase()

/**
 * An engine whose kernel keeps bodies as text, a list of faces each 30 mm wide: an extrude is a box's bottom, one side
 * from 0 to its height and its top. Each face is two triangles, 40 mm apart along X. brep.imprint splits a face a
 * plane crosses in two, each piece with a new key, and names each piece's face in `split`.
 */
export function bandEngine(o: { imprint?: boolean } = {}) {
  const ops: string[] = []
  const call = async (op: string, request: unknown): Promise<unknown> => {
    ops.push(op)
    const req = request as Record<string, unknown>
    const salt = req['keySalt'] as number
    const facesOf = (b: unknown) => JSON.parse((b as { smb: string }).smb) as Face[]
    switch (op) {
      case 'brep.count':
        return { bodies: 0 }
      case 'exact.ops':
        return { ops: o.imprint === false ? [] : ['brep.imprint'] }
      case 'brep.extrude':
        return { bodySmb: JSON.stringify([{ key: salt + 1, lo: 0, hi: 0 }, { key: salt + 2, lo: 0, hi: 20 }, { key: salt + 3, lo: 20, hi: 20 }]) }
      case 'brep.imprint': {
        let faces = facesOf(req['body'])
        const split: [number, number][] = []
        let k = 0
        for (const p of req['planes'] as { origin: number[] }[]) {
          const h = p.origin[2]!
          faces = faces.flatMap((f) => {
            if (!(f.lo < h && f.hi > h)) return [f]
            const pieces = [{ key: salt + 50 + k++, lo: f.lo, hi: h }, { key: salt + 50 + k++, lo: h, hi: f.hi }]
            for (const x of pieces) split.push([x.key, f.key])
            return pieces
          })
        }
        return { bodySmb: JSON.stringify(faces), split }
      }
      case 'brep.tessellate': {
        const faces = facesOf(req['body'])
        const positions: number[] = []
        faces.forEach((f, i) => {
          const x = 40 * i
          const quad = f.lo === f.hi ? [[x, 0, f.lo], [x + 30, 0, f.lo], [x + 30, 10, f.lo], [x, 10, f.lo]] : [[x, 0, f.lo], [x + 30, 0, f.lo], [x + 30, 0, f.hi], [x, 0, f.hi]]
          for (const c of [0, 1, 2, 0, 2, 3]) positions.push(...quad[c]!)
        })
        const t = faces.length * 2
        return { positions, indices: Array.from({ length: t * 3 }, (_, i) => i), faceIds: Array.from({ length: t }, (_, i) => Math.floor(i / 2)), faces: faces.map((f, id) => ({ id, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: f.lo }, key: f.key })), normals: new Array(t * 6).fill(0) }
      }
      case 'paint.select': {
        const mesh = req['mesh'] as { indices: number[] }
        // a whole part takes the state on every triangle; a band, as the mesh path paints it, splits the triangles its
        // edge crosses, so each of those has a text of its own
        const part = (req['target'] as { kind: string }).kind === 'part'
        return { changed: Object.fromEntries(Array.from({ length: mesh.indices.length / 3 }, (_, t) => [String(t), part ? leaf(req['state'] as number) : `${t}${leaf(req['state'] as number)}`])), changedTriangles: mesh.indices.length / 3, selectedAreaMm2: 0, regionCount: 1, regions: [] }
      }
      case 'paint.regions': {
        const painted = Object.values(req['paint'] as Record<string, string>)
        const states = [...new Set(painted)].map((s) => ({ state: Number.parseInt(s, 16) >> 2, areaMm2: 0, triangles: painted.filter((x) => x === s).length, regionCount: 1, regions: [] }))
        return { states }
      }
      case 'render':
        return { widthPx: 64, heightPx: 64, objects: (req['objects'] as unknown[]).length }
    }
    throw new Error(`unexpected operation ${op}`)
  }
  return { call, ops }
}

