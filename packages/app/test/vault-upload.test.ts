// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Host, Listing } from '@slicerx/contracts'
import { createStore } from '@slicerx/store'
import { renderCover, stlMesh } from '../src/export/cover'
import { HostContext } from '../src/host'
import { openUpload, resetSheets } from '../src/features/store/sheets'
import { formatOf, parseTags, submitUpload, uploadErrors, uploadName, uploadStage, UploadHost } from '../src/features/store/upload'
import { boxMesh } from '../src/plate/mesh-ops'

afterEach(() => {
  cleanup()
  resetSheets()
})

const zip = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array<number>(64).fill(7)])
const listing = (o: Partial<Listing>): Listing => ({ id: 'l', creatorId: 'c', slug: 's', title: 'T', license: 'cc0', status: 'pending', tags: [], createdAt: '2026-10-01T00:00:00Z', ...o })
const version = (scanStatus: 'uploading' | 'queued' | 'scanning' | 'clean' | 'rejected', reviewStatus: 'pending' | 'approved' | 'rejected' = 'pending') =>
  ({ id: 'v', listingId: 'l', version: '1.0.0', format: '3mf', sizeBytes: 1, sha256: 'x', createdAt: '2026-10-01T00:00:00Z', scanStatus, reviewStatus }) as NonNullable<Listing['currentVersion']>

describe('upload details', () => {
  it('keeps tags as lowercase hyphenated words, once each', () => {
    expect(parseTags(' Desk , print in place,desk, Cable Clips!! ,')).toEqual(['desk', 'print-in-place', 'cable-clips'])
    expect(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`).join(','))).toHaveLength(20)
  })

  it('names the file the way the store takes it', () => {
    expect(formatOf('Cube.STL')).toBe('stl')
    expect(formatOf('a.obj')).toBeNull()
    expect(uploadName('My Cube (v2).3MF', '3mf')).toBe('my-cube-v2.3mf')
    expect(uploadName('...', 'stl')).toBe('model.stl')
  })

  it('needs a file, a title, and only your own Vault designs', () => {
    const d = { title: '', description: '', tags: '', license: 'cc0' as const }
    expect(Object.keys(uploadErrors(d, null, 'me')).sort()).toEqual(['file', 'title'])
    const theirs = { name: 'a.sx3mf', bytes: zip(), format: 'sx3mf' as const, vaultCreators: ['someone-else'] }
    expect(uploadErrors({ ...d, title: 'A' }, theirs, 'me').file).toMatch(/another creator/)
    expect(uploadErrors({ ...d, title: 'A' }, { ...theirs, vaultCreators: ['me'] }, 'me')).toEqual({})
  })

  it('reads where an upload stands', () => {
    expect(uploadStage(listing({ currentVersion: version('uploading') })).label).toBe('Uploading')
    expect(uploadStage(listing({ currentVersion: version('queued') })).stage).toBe('scanning')
    expect(uploadStage(listing({ currentVersion: version('clean') })).label).toBe('In review')
    expect(uploadStage(listing({ status: 'approved', currentVersion: version('clean', 'approved') })).label).toBe('Live')
    expect(uploadStage(listing({ status: 'rejected', reviewNote: 'Add a photo' }))).toEqual({ stage: 'rejected', label: 'Sent back', note: 'Add a photo' })
  })
})

describe('cover drawing', () => {
  it('draws a model over the ground and reads STL', () => {
    const box = boxMesh(20, 20, 20)
    const img = renderCover([{ positions: box.positions, indices: box.indices, color: '#ff79c6' }], 80, 60)
    expect(img.rgba).toHaveLength(80 * 60 * 4)
    const center = (30 * 80 + 40) * 4
    // The middle is the model (pink washed into the ground), the corner is the ground.
    expect(img.rgba[center]).toBeGreaterThan(img.rgba[center + 1]! + 10)
    expect(img.rgba[0]).toBe(0x26)
    const stl = new Uint8Array(84 + 50)
    new DataView(stl.buffer).setUint32(80, 1, true)
    expect(stlMesh(stl)?.indices).toHaveLength(3)
    expect(stlMesh(new TextEncoder().encode('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid'))?.positions).toHaveLength(9)
    expect(stlMesh(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('sending an upload', () => {
  it('creates the listing with its cover and file, then it waits for review', async () => {
    const store = createStore({ offline: true, signedInAs: 'marrow' })
    const steps: string[] = []
    const r = await submitUpload(
      store,
      { title: 'Calibration cube', description: '20 mm', tags: 'calibration, test', license: 'cc0' },
      { name: 'Cube.3mf', bytes: zip(), format: '3mf', vaultCreators: [], printProfile: { printerModel: 'Bambu Lab A1 mini', process: '0.20 mm layers', filament: 'PLA', timeS: 1500, grams: 9.5 } },
      { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png', preview: 'blob:x' },
      true,
      (s) => steps.push(s),
    )
    expect(r.ok).toBe(true)
    expect(steps).toEqual(['Uploading the cover', 'Creating the listing', 'Uploading the file'])
    const mine = (await store.myListings()).find((l) => l.title === 'Calibration cube')
    expect(mine?.tags).toEqual(['calibration', 'test'])
    expect(mine?.coverUrl).toMatch(/^data:image\/png/)
    expect(mine?.currentVersion?.format).toBe('sx3mf')
    expect(mine?.currentVersion?.printProfiles?.['Bambu Lab A1 mini']?.timeS).toBe(1500)
    expect(uploadStage(mine!).label).toBe('In review')
  })

  it('removes the listing again when the file is refused', async () => {
    const store = createStore({ offline: true, signedInAs: 'marrow' })
    const before = (await store.myListings()).length
    const r = await submitUpload(store, { title: 'Bad', description: '', tags: '', license: 'cc0' }, { name: 'bad.3mf', bytes: new Uint8Array(0), format: '3mf', vaultCreators: [] }, null, false)
    expect(r.ok).toBe(false)
    expect((await store.myListings()).length).toBe(before)
  })

  it('lists your uploads with where each stands', async () => {
    const store = createStore({ offline: true, signedInAs: 'marrow' })
    await submitUpload(store, { title: 'Fresh upload', description: '', tags: '', license: 'cc0' }, { name: 'f.3mf', bytes: zip(), format: '3mf', vaultCreators: [] }, null, false)
    const host = { kind: 'web', capabilities: { secureStorage: false }, store } as unknown as Host
    render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(HostContext.Provider, { value: host }, createElement(UploadHost))))
    act(() => openUpload('list'))
    const list = await screen.findByRole('list', { name: 'Your uploads' })
    await waitFor(() => expect(within(list).getByText('Fresh upload')).toBeTruthy())
    const row = within(list).getByText('Fresh upload').closest('li') as HTMLElement
    expect(within(row).getByText('In review')).toBeTruthy()
    expect(within(list).getAllByText('Live').length).toBeGreaterThan(0)
  })
})
