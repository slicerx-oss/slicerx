// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone reads a 3MF project's plates from the file itself, before anything is uploaded.
import { deflateRawSync } from 'zlib'
import { inflateRaw, platesOf, readPlates, zipEntry } from './plates'

const text = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'))

/** A zip of `files`, each stored (method 0) or deflated (method 8). */
function zip(files: { name: string; data: Uint8Array; deflate?: boolean; level?: number }[]): Uint8Array {
  const locals: Uint8Array[] = []
  const dir: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const body = f.deflate ? new Uint8Array(deflateRawSync(f.data, { level: f.level ?? 6 })) : f.data
    const name = Buffer.from(f.name, 'utf8')
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(f.deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(f.deflate ? 8 : 0, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(f.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    locals.push(local, body)
    dir.push(central)
    offset += local.length + body.length
  }
  const size = dir.reduce((a, b) => a + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, ...dir, end]))
}

const MODEL = text('<?xml version="1.0"?><model unit="millimeter"><resources/><build/></model>')

function settings(plates: { id: number; name?: string; objects: number[] }[]): string {
  const body = plates
    .map(
      (p) =>
        `<plate><metadata key="plater_id" value="${p.id}"/>${p.name !== undefined ? `<metadata key="plater_name" value="${p.name}"/>` : ''}` +
        p.objects.map((o) => `<model_instance><metadata key="object_id" value="${o}"/><metadata key="instance_id" value="0"/></model_instance>`).join('') +
        '</plate>',
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><config><object id="2"><metadata key="name" value="Base"/></object>${body}</config>`
}

describe('reading the plates of a 3MF project on the phone', () => {
  it('lists each plate with objects, its name and object count, from a deflated settings file', () => {
    const xml = settings([
      { id: 1, name: 'Base &amp; feet', objects: [2, 3, 4] },
      { id: 2, objects: [5] },
      { id: 3, name: 'Empty', objects: [] },
      { id: 4, name: 'Lid', objects: [6, 7] },
    ])
    const file = zip([
      { name: '3D/3dmodel.model', data: MODEL, deflate: true },
      { name: 'Metadata/model_settings.config', data: text(xml), deflate: true },
    ])
    expect(readPlates(file)).toEqual([
      { plate: 1, name: 'Base & feet', objects: 3 },
      { plate: 2, name: '', objects: 1 },
      { plate: 4, name: 'Lid', objects: 2 },
    ])
  })

  it('reads a stored settings file and an ArrayBuffer the same way', () => {
    const xml = settings([{ id: 1, objects: [1] }, { id: 2, name: 'Plate two', objects: [2] }])
    const file = zip([{ name: 'Metadata/model_settings.config', data: text(xml) }])
    expect(readPlates(file.slice().buffer)).toEqual([
      { plate: 1, name: '', objects: 1 },
      { plate: 2, name: 'Plate two', objects: 1 },
    ])
  })

  it('reads plate names in any script', () => {
    const xml = settings([{ id: 1, name: 'Deckel, grün', objects: [1] }, { id: 2, name: '蓋', objects: [2] }])
    expect(readPlates(zip([{ name: 'Metadata/model_settings.config', data: text(xml), deflate: true }])).map((p) => p.name)).toEqual(['Deckel, grün', '蓋'])
  })

  it('gives no plates for a plain 3MF, a file that is not a zip, and a broken settings entry', () => {
    expect(readPlates(zip([{ name: '3D/3dmodel.model', data: MODEL, deflate: true }]))).toEqual([])
    expect(readPlates(text('solid cube\nendsolid cube\n'))).toEqual([])
    const broken = zip([{ name: 'Metadata/model_settings.config', data: text(settings([{ id: 1, objects: [1] }])), deflate: true }])
    // Flip bits inside the deflated data.
    for (let i = 65; i < 85; i++) broken[i] = broken[i]! ^ 0xff
    expect(() => readPlates(broken)).not.toThrow()
  })

  it('counts each plate number once and skips plates with no number', () => {
    const xml = '<config><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate>' +
      '<plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate>' +
      '<plate><model_instance><metadata key="object_id" value="3"/></model_instance></plate></config>'
    expect(platesOf(xml)).toEqual([{ plate: 1, name: '', objects: 1 }])
  })

  it('finds an entry without regard to case', () => {
    const file = zip([{ name: 'metadata/Model_Settings.config', data: text('abc') }])
    expect(zipEntry(file, 'metadata/model_settings.config')).toEqual(text('abc'))
  })
})

describe('the phone inflater', () => {
  it('matches the data for fixed, dynamic and stored blocks', () => {
    const repetitive = text(settings(Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Plate ${i + 1}`, objects: [i * 2 + 1, i * 2 + 2] }))))
    let seed = 7
    const noise = new Uint8Array(70_000).map(() => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24)
    for (const [data, level] of [
      [text('abc'), 6],
      [repetitive, 9],
      [repetitive, 1],
      [noise, 0],
      [noise, 6],
      [new Uint8Array(0), 6],
    ] as const) {
      expect(inflateRaw(new Uint8Array(deflateRawSync(data, { level })), 1 << 20)).toEqual(data)
    }
  })

  it('stops at the output cap', () => {
    const zeros = new Uint8Array(deflateRawSync(new Uint8Array(1 << 20), { level: 9 }))
    expect(() => inflateRaw(zeros, 4096)).toThrow('inflated data is too large')
  })

  it('refuses data that ends early', () => {
    const packed = new Uint8Array(deflateRawSync(text('hello hello hello hello'), { level: 9 }))
    expect(() => inflateRaw(packed.subarray(0, packed.length - 2), 1024)).toThrow()
  })
})
