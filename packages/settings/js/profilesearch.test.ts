// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, describe, expect, it } from 'vitest'
import { searchProfiles, setProfileProvider } from './profilesearch'

const names = async (q: string) => (await searchProfiles(q)).map((h) => `${h.vendor} ${h.model}`)

afterEach(() => setProfileProvider(undefined))

describe('searchProfiles', () => {
  it('searches the built-in printer profiles and lists the profile id and nozzles', async () => {
    const [hit] = await searchProfiles('mk4s')
    expect(hit).toEqual({ id: 'prusa-mk4s', vendor: 'Prusa Research', model: 'MK4S', nozzles: [0.25, 0.4, 0.6, 0.8] })
  })
  it('lists every model of a vendor for a vendor-only query', async () => {
    const all = await names('bambu')
    expect(all).toHaveLength(11)
    expect(all.every((m) => m.startsWith('Bambu Lab '))).toBe(true)
    expect((await names('voron')).length).toBe(8)
  })
  it('matches partial names', async () => {
    expect(await names('a1 mi')).toEqual(['Bambu Lab A1 mini'])
    expect((await names('x1 carb'))[0]).toBe('Bambu Lab X1 Carbon')
    expect(await names('2.4 3')).toContain('Voron Design Voron 2.4 300')
    expect(await names('core')).toEqual(['Prusa Research Core One'])
  })
  it('forgives typos', async () => {
    expect(await names('bamboo lab')).toContain('Bambu Lab A1')
    expect(await names('prussa mk4s')).toContain('Prusa Research MK4S')
    expect(await names('creaity k1')).toEqual(expect.arrayContaining(['Creality K1', 'Creality K1 Max']))
  })
  it('finds nothing for nonsense and lists everything for an empty query', async () => {
    expect(await names('zzzzqqqq')).toEqual([])
    expect((await searchProfiles('')).length).toBe(69)
  })
  it('uses an installed provider, and returns an empty list when it throws', async () => {
    setProfileProvider(() => [{ id: 'mine', vendor: 'Acme', model: 'Rocket 3000', nozzles: [0.4] }])
    expect((await searchProfiles('rocket')).map((h) => h.id)).toEqual(['mine'])
    setProfileProvider(() => { throw new Error('gone') })
    expect(await searchProfiles('rocket')).toEqual([])
  })
})
