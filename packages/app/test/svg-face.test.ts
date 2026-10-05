// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An SVG outline placed on a face and cut into it, or added on the bed (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { pickFace, shapeProfile } from '../src/geom/cad'
import { toGeom } from '../src/geom/client'
import { applyExtrude, BED_FRAME } from '../src/cad/cad-ops'
import { readSvgFile, SVG_MAX_BYTES } from '../src/cad/svg-file'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('svg-face-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
// Two fills, a square ring and a dot, 100 units wide.
const ART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#ff79c6" d="M0 0H100V100H0Z M20 20V80H80V20Z"/><circle fill="#50fa7b" cx="50" cy="50" r="10"/></svg>'

beforeEach(() => {
  set({ plate: [{ id: 'a', name: 'Plate', handle: handle('a'), parts: [boxMesh(60, 60, 5)], colors: ['#bd93f9'], transform: compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }], selection: 'a', selectedIds: ['a'] })
})

describe('the SVG file', () => {
  it('reads SVG text and refuses other files and huge ones', async () => {
    await expect(readSvgFile(new File([ART], 'logo.svg'))).resolves.toEqual({ name: 'logo.svg', text: ART })
    await expect(readSvgFile(new File(['hello'], 'notes.svg'))).rejects.toThrow(/not an SVG/)
    await expect(readSvgFile(new File([new Uint8Array(SVG_MAX_BYTES + 1)], 'big.svg'))).rejects.toThrow(/larger than 4 MB/)
  })
})

describe('SVG outline on a face', () => {
  it('previews the merged outline at the typed width and cuts it into the top face', async () => {
    const e = get().plate[0]!
    const face = await pickFace({ mesh: toGeom(e.parts[0]!), transform: e.transform }, { triangle: 2, at: [100, 100, 5] })
    const outline = await shapeProfile({ type: 'svg', svg: ART, widthMm: 40 }, { center: face.at, rotationDeg: 15 })
    // The ring and the dot: the ring keeps its hole.
    expect(outline.length).toBe(2)
    expect(outline.some((p) => p.holes.length === 1)).toBe(true)
    const r = await applyExtrude(host, { frame: face.frame, shape: { type: 'svg', svg: ART, widthMm: 40 }, placement: { center: face.at, rotationDeg: 15 }, spec: { distanceMm: 1, operation: 'cut' }, target: { objectId: 'a', partIndex: 0 }, name: 'logo' })
    expect(r.message).toMatch(/^Cut 1\.\d\d cm³ out of Plate\.$/)
    expect(get().plate).toHaveLength(1)
  })

  it('adds the outline on the bed as a new body', async () => {
    const r = await applyExtrude(host, { frame: BED_FRAME, shape: { type: 'svg', svg: ART, widthMm: 30 }, placement: { center: [40, 40] }, spec: { distanceMm: 2, operation: 'new' }, name: 'logo' })
    expect(r.message).toMatch(/^Added logo, /)
    expect(get().plate).toHaveLength(2)
    expect(get().plate[1]!.transform[12]).toBeCloseTo(40)
  })
})
