// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import { applyCalibrationResult } from '../src/calibration/actions'
import { applyPreset, capture, deletePreset, exportOrcaJson, exportPresetJson, importPresetText, loadPresets, parsePresetFile, renamePreset, restorePresets, savePreset, updatePreset } from '../src/presets/presets'
import { memoryStore, setPresetStore } from '../src/presets/store'
import { get, set } from '../src/state/store'

beforeEach(() => {
  setPresetStore(memoryStore())
  set({ overrides: {}, userPresets: [], activePresets: {} })
})

describe('user presets', () => {
  it('captures only the changed keys of one kind', () => {
    set({ overrides: { wall_loops: 4, nozzle_temperature: [205], retraction_length: [1.2] } })
    expect(capture('process').values).toEqual({ wall_loops: 4 })
    expect(capture('filament').values).toEqual({ nozzle_temperature: [205] })
    expect(capture('printer').values).toEqual({ retraction_length: [1.2] })
    expect(capture('process').easy).toBeDefined()
    expect(capture('filament').easy).toBeUndefined()
  })

  it('saves, applies over the current changes of its kind only, renames and deletes', async () => {
    set({ overrides: { wall_loops: 4, nozzle_temperature: [205] } })
    const p = await savePreset('filament', 'Silk PLA')
    expect(get().activePresets.filament).toBe(p.id)
    set({ overrides: { wall_loops: 3, nozzle_temperature: [230], filament_flow_ratio: [0.9] } })
    applyPreset(p.id)
    expect(get().overrides).toEqual({ wall_loops: 3, nozzle_temperature: [205] })
    await renamePreset(p.id, 'Silk PLA v2')
    expect(get().userPresets[0]!.name).toBe('Silk PLA v2')
    await deletePreset(p.id)
    expect(get().userPresets).toEqual([])
    expect(get().activePresets.filament).toBeUndefined()
  })

  it('keeps names unique within a kind and trims them', async () => {
    const a = await savePreset('process', '  Fast  ', { values: {} })
    const b = await savePreset('process', 'fast', { values: {} })
    const c = await savePreset('filament', 'Fast', { values: {} })
    expect([a.name, b.name, c.name]).toEqual(['Fast', 'fast 2', 'Fast'])
  })

  it('persists and comes back at startup, putting the presets in use back in place', async () => {
    set({ overrides: { nozzle_temperature: [212] } })
    const p = await savePreset('filament', 'PETG')
    // A restart: changed settings are not kept, the presets and which ones are in use are.
    set({ overrides: {}, userPresets: [] })
    await restorePresets()
    expect(get().userPresets.map((x) => x.name)).toEqual(['PETG'])
    expect(get().overrides['nozzle_temperature']).toEqual([212])
    expect(get().activePresets.filament).toBe(p.id)
  })

  it('loading the list, as Settings > Presets and the command bar do, keeps a setting changed after applying a preset', async () => {
    const p = await savePreset('process', 'My fast print', { values: { wall_loops: 4 } })
    applyPreset(p.id)
    set((s) => ({ overrides: { ...s.overrides, wall_loops: 6 } }))
    // Settings > Presets loads the list each time it opens.
    await loadPresets()
    expect(get().overrides['wall_loops']).toBe(6)
    // The command bar loads it when it opens while the list is empty.
    set({ userPresets: [] })
    await loadPresets()
    expect(get().overrides['wall_loops']).toBe(6)
    expect(get().activePresets.process).toBe(p.id)
  })

  it('a reload that finds the same presets keeps the list, so a fresh slice stays fresh', async () => {
    // The command bar loads the presets each time it opens while there are none, and the list is a slice input.
    const none = get().userPresets
    await loadPresets()
    expect(get().userPresets).toBe(none)
    await savePreset('filament', 'PETG', { values: {} })
    const one = get().userPresets
    await loadPresets()
    expect(get().userPresets).toBe(one)
  })

  it('updates a preset with the current changes', async () => {
    set({ overrides: { nozzle_temperature: [200] } })
    const p = await savePreset('filament', 'PLA')
    set({ overrides: { nozzle_temperature: [208] } })
    await updatePreset(p.id)
    expect(get().userPresets[0]!.values).toEqual({ nozzle_temperature: [208] })
  })
})

describe('preset files', () => {
  it('round trips our own format', async () => {
    set({ overrides: { wall_loops: 5 } })
    const p = await savePreset('process', 'Strong')
    const parsed = parsePresetFile(exportPresetJson(p))
    expect(parsed).toMatchObject({ kind: 'process', name: 'Strong', values: { wall_loops: 5 }, skipped: [] })
  })

  it('reads an Orca profile, dropping unknown keys and tolerating a parent we do not have', () => {
    const orca = JSON.stringify({ type: 'filament', name: 'My PLA', inherits: 'Generic PLA @System', from: 'User', nozzle_temperature: ['207'], not_a_setting: '1' })
    const parsed = parsePresetFile(orca)
    expect(parsed.kind).toBe('filament')
    expect(parsed.name).toBe('My PLA')
    expect(parsed.values['nozzle_temperature']).toEqual([207])
    expect(parsed.skipped).toContain('not_a_setting')
  })

  it('exports a profile Orca can read back', async () => {
    const p = await savePreset('filament', 'Tuned', { values: { nozzle_temperature: [211] } })
    const json = JSON.parse(exportOrcaJson(p))
    expect(json).toMatchObject({ type: 'filament', name: 'Tuned', from: 'User' })
    expect(json.nozzle_temperature).toEqual(['211'])
  })

  it('rejects files that are not presets, with a plain message', () => {
    expect(() => parsePresetFile('nope')).toThrow(/not valid JSON/)
    expect(() => parsePresetFile('[]')).toThrow(/not a preset/)
    expect(() => parsePresetFile('{"type":"model"}')).toThrow(/not a SlicerX, Orca/)
    expect(() => parsePresetFile('{"slicerx":"preset","kind":"nope"}')).toThrow(/valid type/)
    expect(() => parsePresetFile(' '.repeat(3_000_000))).toThrow(/too large/)
  })

  it('ignores keys of the wrong kind in our own format', () => {
    const parsed = parsePresetFile(JSON.stringify({ slicerx: 'preset', kind: 'process', name: 'X', values: { wall_loops: 3, nozzle_temperature: [200] } }))
    expect(parsed.values).toEqual({ wall_loops: 3 })
    expect(parsed.skipped).toEqual(['nozzle_temperature'])
  })

  it('imports without switching to the preset', async () => {
    const r = await importPresetText(JSON.stringify({ slicerx: 'preset', kind: 'process', name: 'In', values: { wall_loops: 6 } }))
    expect(r.preset.name).toBe('In')
    expect(get().overrides['wall_loops']).toBeUndefined()
  })
})

describe('calibration results in a preset', () => {
  it('writes a chosen value into one tuned filament preset and leaves the shared settings alone', async () => {
    applyCalibrationResult('temp-tower', 208)
    await new Promise((r) => setTimeout(r, 20))
    const p = get().userPresets.find((x) => x.kind === 'filament')
    expect(p?.values['nozzle_temperature']).toEqual([208])
    expect(get().activePresets.filament).toBeUndefined()
    expect(get().overrides['nozzle_temperature']).toBeUndefined()
    applyCalibrationResult('flow', 0.97)
    await new Promise((r) => setTimeout(r, 20))
    expect(get().userPresets.filter((x) => x.kind === 'filament')).toHaveLength(1)
    expect(get().userPresets[0]!.values).toMatchObject({ nozzle_temperature: [208], filament_flow_ratio: [0.97] })
  })
})

describe('calibration results per spool', () => {
  it('a second spool of the same type gets its own preset, and a nozzle change shows retune', async () => {
    const { tuneState } = await import('../src/calibration/tuned')
    set({ slotSetup: { 1: { type: 'PLA', brand: 'Acme', color: '#ff0000' }, 2: { type: 'PLA', brand: 'Acme', color: '#0000ff' } }, profile: { printerId: 'p1', nozzle: 0.4, nozzles: [0.4, 0.6], nozzleFrom: 'choice', tier: 'x', source: 'orca', shippedGcode: false, gcodeKeys: [], limits: {} } })
    applyCalibrationResult('temp-tower', 205, 1)
    await new Promise((r) => setTimeout(r, 20))
    applyCalibrationResult('temp-tower', 215, 2)
    await new Promise((r) => setTimeout(r, 20))
    const fil = get().userPresets.filter((x) => x.kind === 'filament')
    expect(fil).toHaveLength(2)
    expect(fil.map((p) => p.values['nozzle_temperature']).sort()).toEqual([[205], [215]])
    const slot1 = { type: 'PLA', brand: 'Acme', color: '#ff0000' }
    expect(tuneState(get().userPresets, slot1, 'p1', 0.4).state).toBe('tuned')
    expect(tuneState(get().userPresets, slot1, 'p1', 0.6)).toEqual({ state: 'retune', fromNozzleMm: 0.4 })
    expect(tuneState(get().userPresets, slot1, 'p2', 0.4).state).toBe('none')
    applyCalibrationResult('temp-tower', 207, 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(get().userPresets.filter((x) => x.kind === 'filament')).toHaveLength(2)
    set({ slotSetup: {}, profile: null })
  })

  it('two slots of one material keep their own values in the slice, and a nozzle swap falls back to the profile', async () => {
    const { slotConfig } = await import('../src/filament/slots')
    const part = (name: string, slot: number) => ({ id: name, name, handle: { id: name, hash: name, name, triangles: 1, bboxMm: [1, 1, 1], openEdges: 0, parts: [{ name, slot, triangles: 1 }] }, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as never
    const profile = (nozzle: number) => ({ printerId: 'p1', nozzle, nozzles: [0.4, 0.6], nozzleFrom: 'choice', tier: 'x', source: 'orca', shippedGcode: false, gcodeKeys: [], limits: {} }) as never
    set({
      plate: [part('a', 1), part('b', 2)],
      overrides: { nozzle_temperature: [200] },
      slotSetup: { 1: { type: 'PLA', brand: 'Acme', color: '#ff0000' }, 2: { type: 'PLA', brand: 'Acme', color: '#0000ff' } },
      profile: profile(0.4),
    })
    applyCalibrationResult('temp-tower', 205, 1)
    await new Promise((r) => setTimeout(r, 20))
    applyCalibrationResult('temp-tower', 225, 2)
    await new Promise((r) => setTimeout(r, 20))
    applyCalibrationResult('flow', 0.95, 2)
    await new Promise((r) => setTimeout(r, 20))
    // Each slot gets its own value; the shared overrides are untouched. Flow is tuned for slot 2 only, so slot 1 keeps the schema default.
    expect(slotConfig(get())['nozzle_temperature']).toEqual([205, 225])
    expect(slotConfig(get())['filament_flow_ratio']).toEqual([1, 0.95])
    expect(get().overrides['nozzle_temperature']).toEqual([200])
    // A 0.6 mm nozzle was never tuned: the profile's value applies, and both spools show Retune.
    set({ profile: profile(0.6) })
    expect(slotConfig(get())['nozzle_temperature']).toBeUndefined()
    const { tuneState } = await import('../src/calibration/tuned')
    expect(tuneState(get().userPresets, { type: 'PLA', brand: 'Acme', color: '#0000ff' }, 'p1', 0.6)).toEqual({ state: 'retune', fromNozzleMm: 0.4 })
    // Back on 0.4 the tuned values load again by themselves.
    set({ profile: profile(0.4) })
    expect(slotConfig(get())['nozzle_temperature']).toEqual([205, 225])
    // Even with no base value in the shared settings, an untuned slot gets the schema default, never slot 2's value.
    set({ overrides: {} })
    expect(slotConfig(get())['filament_flow_ratio']).toEqual([1, 0.95])
    set({ plate: [], overrides: {}, slotSetup: {}, profile: null })
  })
})

describe('sync files', () => {
  beforeEach(() => set({ presetSync: { deleted: [], changes: [], lastAt: 0 } }))

  it('a deleted preset is remembered, and merging a file that still has it does not bring it back', async () => {
    const { mergeSyncText } = await import('../src/presets/presets')
    const { makeBundle } = await import('../src/presets/sync')
    const p = await savePreset('process', 'Fast')
    await deletePreset(p.id)
    expect(get().presetSync.deleted.map((t) => t.id)).toEqual([p.id])
    const older = makeBundle([{ ...p, updatedAt: p.updatedAt - 10 }], [], [])
    const applied = await mergeSyncText(JSON.stringify(older))
    expect(applied).toEqual([])
    expect(get().userPresets.find((x) => x.id === p.id)).toBeUndefined()
  })

  it('merging a file adds its presets and writes the change notes', async () => {
    const { mergeSyncText } = await import('../src/presets/presets')
    const { makeBundle } = await import('../src/presets/sync')
    const remote = makeBundle([{ id: 'r1', kind: 'filament', name: 'Remote PLA', values: { nozzle_temperature: 215 }, createdAt: 1, updatedAt: 5 }], [], [])
    const applied = await mergeSyncText(JSON.stringify(remote))
    expect(applied.map((c) => `${c.action}:${c.name}`)).toEqual(['added:Remote PLA'])
    expect(get().userPresets.map((x) => x.name)).toContain('Remote PLA')
    expect(get().presetSync.changes.some((c) => c.name === 'Remote PLA')).toBe(true)
  })
})
