// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Custom G-code gets the engine's normal checks only when it is the text SlicerX ships, as in the app.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import type { ProfileCatalog, ProfileDetail } from '../src/profiles'
import type { SliceJob } from '../src/slicer'
import { connect } from './helpers'

describe('trusted G-code', () => {
  /** The real catalog, with one extra profile that SlicerX does not ship. */
  const withUserProfile = (catalog: ProfileCatalog, extra: ProfileDetail): ProfileCatalog =>
    Object.assign(Object.create(catalog) as ProfileCatalog, {
      get: (q: string) => (q === extra.id ? extra : catalog.get(q)),
    })
  const userPrinter: ProfileDetail = { id: 'user:my-a1', name: 'My A1', section: 'printer', source: 'knowledge', config: { machine_start_gcode: 'G28\nM211 S0' }, chain: ['My A1'], unknown_keys: [] }

  it('trusts only G-code from profiles SlicerX ships', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:bambu-a1'])
    expect(resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:bambu-a1'], undefined).trustedGcode).toBe(true)
    const catalog = withUserProfile(h.ctx.profiles, userPrinter)
    expect(resolveSliceConfig(h.ctx.store, catalog, ['machine:bambu-a1', 'user:my-a1'], undefined).trustedGcode).toBe(false)
    expect(resolveSliceConfig(h.ctx.store, catalog, ['user:my-a1', 'machine:bambu-a1'], undefined).trustedGcode).toBe(false)
    expect(resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:bambu-a1'], { machine_end_gcode: 'M18' }).trustedGcode).toBe(false)
  })

  it('applies the same rule to a project sliced through mimir', async () => {
    const h = await connect()
    const seen: (boolean | undefined)[] = []
    const backend = h.ctx.slicer!
    const slice = backend.slice.bind(backend)
    backend.slice = (job: SliceJob) => {
      seen.push(job.trustedGcode)
      return slice(job)
    }
    await h.call('slicerx_project_open', { name: 'A1 cubes', profiles: ['machine:bambu-a1'] })
    await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    expect((await h.call('slicerx_slice', {})).isError).toBeFalsy()
    await h.call('slicerx_project_set_overrides', { changes: { machine_end_gcode: 'M18' } })
    await h.call('slicerx_slice', {})
    expect(seen).toEqual([true, false])
  })
})
