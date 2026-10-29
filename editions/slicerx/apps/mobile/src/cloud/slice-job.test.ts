// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a phone slice puts the model. The phone measures only STL files. A 3MF from
// Bambu Studio or Orca holds its own build positions, and an STL can sit anywhere, so a
// transform built from a size alone pushed models off the bed. Without one the cloud
// slicer centers the real mesh and sets it down.
import { EASY_GOALS, type PrinterInfo, type SliceRequest, type SlicerHost } from '@slicerx/contracts'
import { estimateOf, runCloudSlice, type PhoneModel } from './slice-job'
import { boxStl } from './stl'
import { createCloudStub } from './stub'

const A1: PrinterInfo = { id: 'bay-1', name: 'Bay 1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu', nozzleCount: 1 }

/** The stub, keeping each request it is asked to slice. */
function recording(): { cloud: SlicerHost; sent: SliceRequest[] } {
  const stub = createCloudStub({ stageMs: 0, queueMs: 0 })
  const sent: SliceRequest[] = []
  return {
    sent,
    cloud: {
      ...stub,
      slice: (req, o) => {
        sent.push(req)
        return stub.slice(req, o)
      },
    },
  }
}

/** A file that starts like a 3MF (a zip), which the phone cannot read a mesh from. */
function zipBytes(size: number): ArrayBuffer {
  const b = new Uint8Array(size)
  b.set([0x50, 0x4b, 0x03, 0x04])
  return b.buffer
}

/** A binary STL box with every vertex moved by `d`. */
function movedBox(size: [number, number, number], d: [number, number, number]): ArrayBuffer {
  const buf = boxStl(size)
  const v = new DataView(buf)
  const n = v.getUint32(80, true)
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 9; k++) {
      const o = 84 + t * 50 + 12 + k * 4
      v.setFloat32(o, v.getFloat32(o, true) + d[k % 3]!, true)
    }
  return buf
}

function model(name: string, data: ArrayBuffer): PhoneModel {
  return { id: name, name, origin: 'file', load: async () => data }
}

describe('placing a phone slice on the bed', () => {
  it('sends a 3MF with no transform, so the cloud slicer centers it', async () => {
    const { cloud, sent } = recording()
    const out = await runCloudSlice(cloud, { model: model('Project.3mf', zipBytes(4096)), printer: A1, easy: EASY_GOALS.standard, material: 'pla' }, () => undefined)
    expect(sent).toHaveLength(1)
    const obj = sent[0]?.plate.objects[0]
    expect(obj?.name).toBe('Project.3mf')
    expect(obj).not.toHaveProperty('transform')
    expect(out.sizeMm).toBeUndefined()
    expect(out.warnings).toEqual([])
  })

  it('sends an STL with no transform too, wherever its coordinates sit, and keeps its measured size', async () => {
    const { cloud, sent } = recording()
    const out = await runCloudSlice(cloud, { model: model('Bracket.stl', movedBox([20, 30, 40], [300, 300, 5])), printer: A1, easy: EASY_GOALS.standard, material: 'pla' }, () => undefined)
    expect(sent[0]?.plate.objects[0]).not.toHaveProperty('transform')
    expect(out.sizeMm).toEqual([20, 30, 40])
    expect(out.warnings).toEqual([])
  })

  it('still warns when a measured STL is larger than the build volume', async () => {
    const { cloud } = recording()
    const out = await runCloudSlice(cloud, { model: model('Tall.stl', boxStl([40, 40, 300])), printer: A1, easy: EASY_GOALS.standard, material: 'pla' }, () => undefined)
    expect(out.warnings[0]).toMatch(/larger than the 256 x 256 x 256 mm build volume of Bay 1/)
  })
})

describe('the send screen estimate', () => {
  it('gives no estimate for a 3MF, which the phone cannot size', async () => {
    const { cloud } = recording()
    const out = await runCloudSlice(cloud, { model: model('Project.3mf', zipBytes(4096)), printer: A1, easy: EASY_GOALS.standard, material: 'pla' }, () => undefined)
    expect(estimateOf(out)).toBeNull()
  })

  it('estimates a measured STL', async () => {
    const { cloud } = recording()
    const out = await runCloudSlice(cloud, { model: model('Cube.stl', boxStl([20, 20, 20])), printer: A1, easy: EASY_GOALS.standard, material: 'pla' }, () => undefined)
    const e = estimateOf(out)
    expect(e?.plates).toBe(1)
    expect(e?.timeS).toBeGreaterThan(0)
    expect(e?.grams).toBeGreaterThan(0)
  })
})

describe('the fit on the bed', () => {
  it('says where a measured model runs past the bed, the part centered as the cloud slicer places it', async () => {
    const { cloud } = recording()
    const out = await runCloudSlice(cloud, { model: model('Bracket.stl', boxStl([300, 200, 5])), printer: A1, easy: EASY_GOALS.standard, material: 'pla' }, () => undefined)
    expect(out.fit).toEqual({
      fits: false,
      bed: [256, 256, 256],
      size: [300, 200, 5],
      // centered on the 256 mm bed: 22 mm past each side in x, inside in y
      footprint: { min: [-22, 28], max: [278, 228] },
      over: [44, 0, 0],
    })
  })

  it('fits a part that stands inside, and says nothing of a file it cannot measure', async () => {
    const { cloud } = recording()
    const cube = await runCloudSlice(cloud, { model: model('Cube.stl', boxStl([20, 20, 20])), printer: A1, easy: EASY_GOALS.standard, material: 'pla' }, () => undefined)
    expect(cube.fit).toMatchObject({ fits: true, over: [0, 0, 0] })
    const tall = await runCloudSlice(cloud, { model: model('Tall.stl', boxStl([40, 40, 300])), printer: A1, easy: EASY_GOALS.standard, material: 'pla' }, () => undefined)
    expect(tall.fit).toMatchObject({ fits: false, over: [0, 0, 44] })
    const project = await runCloudSlice(cloud, { model: model('Project.3mf', zipBytes(4096)), printer: A1, easy: EASY_GOALS.standard, material: 'pla' }, () => undefined)
    expect(project.fit).toBeUndefined()
  })
})
