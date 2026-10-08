// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The capability table in contracts is written out to keep the app shell small; it must say what the
// connector manifests say.
import { describe, expect, it } from 'vitest'
import { PLUGIN_CAPABILITIES, pluginHas } from '@slicerx/contracts/printers'
import manifests from '../../connect/manifests.json' with { type: 'json' }

describe('plugin capabilities', () => {
  it('match packages/connect/manifests.json, plugin for plugin', () => {
    const fromManifests = Object.fromEntries(manifests.map((m) => [m.id, [...m.capabilities].sort()]))
    const fromTable = Object.fromEntries([...PLUGIN_CAPABILITIES].map(([id, caps]) => [id, [...caps].sort()]))
    expect(fromTable).toEqual(fromManifests)
  })

  it('answers for the capabilities the app gates on', () => {
    expect(pluginHas('bambu-lan', 'project_file')).toBe(true)
    expect(pluginHas('bambuddy', 'rewrites_upload')).toBe(true)
    expect(pluginHas('moonraker', 'slot_write')).toBe(false)
    expect(pluginHas(undefined, 'status')).toBe(false)
    expect(pluginHas('no-such-plugin', 'status')).toBe(false)
  })
})
