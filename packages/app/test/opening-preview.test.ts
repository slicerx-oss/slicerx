// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openingPreview, showOpeningPreview } from '../src/project/opening-preview'
import { zip, zipCompressed } from '../src/export/zip'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('the picture shown while a project opens', () => {
  const blobs: Blob[] = []
  beforeEach(() => {
    blobs.length = 0
    URL.createObjectURL = (b: Blob) => (blobs.push(b), `blob:test/${blobs.length}`)
    URL.revokeObjectURL = () => undefined
  })

  it('shows the plate picture of a project, and only until it is taken down', async () => {
    const bytes = await zipCompressed([
      { name: '3D/3dmodel.model', data: '<model/>' },
      { name: 'Metadata/pick_1.png', data: new Uint8Array([9, 9]) },
      { name: 'Metadata/plate_1.png', data: PNG },
    ])
    const hide = showOpeningPreview(bytes, 'tangela.3mf')
    await vi.waitFor(() => expect(openingPreview()).not.toBeNull())
    const p = openingPreview()!
    expect(p.name).toBe('tangela.3mf')
    expect(p.url).toBe('blob:test/1')
    expect(blobs[0]!.type).toBe('image/png')
    expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(PNG)
    hide()
    expect(openingPreview()).toBeNull()
  })

  it('shows nothing for a project without a picture, or one taken down before its picture was read', async () => {
    showOpeningPreview(zip([{ name: '3D/3dmodel.model', data: '<model/>' }]), 'plain.3mf')
    showOpeningPreview(zip([{ name: 'Metadata/plate_1.png', data: PNG }]), 'quick.3mf')()
    await new Promise((r) => setTimeout(r, 50))
    expect(openingPreview()).toBeNull()
  })
})
