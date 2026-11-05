// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP body colors as filaments, the way a client uses them: slicerx_step_read plans a filament for each body against
// the filaments it is given (or a new project), and slicerx_project_add_model applies the plan to the open project,
// read back with slicerx_project_show.
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, data } from './helpers'

const fixtures = join(import.meta.dirname, '..', '..', 'step-reader', 'test', 'fixtures')
type Body = { name: string; color: string | null; filament: number | null; filament_match: string | null }
type Read = { objects: { name: string; bodies: Body[] }[]; filaments_to_add: { filament: number; color: string }[] }
type Out<T> = { ok?: boolean; summary: string; output: T }
type Added = {
  object_count: number
  part_count: number
  objects: { id: string; name: string; parts: number; part_filaments: { part: string; color: string | null; filament: number }[] }[]
  filaments_added: { filament: number; color: string }[]
}
type Shown = { objects: { id: string; parts: number }[]; filaments: { slot: number; color: string; source: string }[] }

let h: Awaited<ReturnType<typeof connect>>
const read = async (args: Record<string, unknown>) => data<Read>((await h.call('slicerx_step_read', { model: join(h.dir, 'assembly-colors.step'), ...args })) as CallToolResult)
const call = async <T,>(name: string, args: Record<string, unknown> = {}) => data<Out<T>>(await h.call(name, args))
const picks = (r: Read) => r.objects.flatMap((o) => o.bodies.map((b) => [b.name, b.filament, b.filament_match]))

beforeAll(async () => {
  h = await connect()
  for (const f of ['assembly.step', 'assembly-colors.step', 'assembly.igs']) copyFileSync(join(fixtures, f), join(h.dir, f))
})
afterAll(async () => {
  await h.client.close()
})

describe('slicerx_step_read filaments', () => {
  it('takes the project filaments and the slot limit as inputs', async () => {
    // on the connection the reads below use: the SDK client checks each answer against the output schema it listed
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_step_read')!
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['filaments', 'max_filaments', 'model', 'output', 'quality'])
  })

  it('plans a new project: filament 1 stays with the uncolored body, each color gets a filament of its own', async () => {
    const r = await read({})
    expect(picks(r)).toEqual([['base', 2, 'new'], ['post', null, null], ['cube', 3, 'new']])
    expect(r.filaments_to_add).toEqual([{ filament: 2, color: '#ff0000' }, { filament: 3, color: '#0040ff' }])
  })

  it('matches the filaments it is given, and keeps to max_filaments', async () => {
    const r = await read({ filaments: ['#F8F8F2', '#C12E1F'], max_filaments: 2 })
    expect(picks(r)).toEqual([['base', 2, 'match'], ['post', null, null], ['cube', 2, 'nearest']])
    expect(r.filaments_to_add).toEqual([])
    const room = await read({ filaments: ['#f8f8f2', '#c12e1f'] })
    expect(picks(room)).toEqual([['base', 2, 'match'], ['post', null, null], ['cube', 3, 'new']])
  })

  it('plans nothing for a file without colors, and refuses a filament that is not a color', async () => {
    const plain = data<Read>((await h.call('slicerx_step_read', { model: join(h.dir, 'assembly.step') })) as CallToolResult)
    expect(plain.objects.flatMap((o) => o.bodies.map((b) => b.filament))).toEqual([null, null, null])
    expect(plain.filaments_to_add).toEqual([])
    const bad = await h.call('slicerx_step_read', { model: join(h.dir, 'assembly-colors.step'), filaments: ['reddish'] })
    expect(bad.isError).toBe(true)
  })
})

describe('slicerx_project_add_model with a STEP file', () => {
  it('applies the plan: filaments added with the colors, each body on its filament, read back', async () => {
    expect((await call('slicerx_project_open', { name: 'colors' })).summary).toMatch(/open/)
    const r = await call<Added>('slicerx_project_add_model', { model: join(h.dir, 'assembly-colors.step') })
    expect(r.output).toMatchObject({ object_count: 2, part_count: 3 })
    expect(r.output.objects.map((o) => o.part_filaments.map((p) => [p.part, p.filament]))).toEqual([[['base', 2], ['post', 1]], [['cube', 3]]])
    expect(r.output.filaments_added).toEqual([{ filament: 2, color: '#ff0000' }, { filament: 3, color: '#0040ff' }])
    const shown = await call<Shown>('slicerx_project_show')
    expect(shown.output.filaments.map((f) => [f.slot, f.color])).toEqual([[1, shown.output.filaments[0]!.color], [2, '#ff0000'], [3, '#0040ff']])
    expect(shown.output.objects.map((o) => o.parts)).toEqual([2, 1])
    // a second copy of the file finds its colors in the project now
    const again = await call<Added>('slicerx_project_add_model', { model: join(h.dir, 'assembly-colors.step') })
    expect(again.output.filaments_added).toEqual([])
    expect(again.output.objects.flatMap((o) => o.part_filaments.map((p) => p.filament))).toEqual([2, 1, 3])
  })

  it('plans and applies an IGES file the same way', async () => {
    const r = data<Read>((await h.call('slicerx_step_read', { model: join(h.dir, 'assembly.igs') })) as CallToolResult)
    expect(picks(r)).toEqual([['base', 2, 'new'], ['post', null, null], ['cube', 3, 'new']])
    await call('slicerx_project_open', { name: 'iges' })
    const added = await call<Added>('slicerx_project_add_model', { model: join(h.dir, 'assembly.igs') })
    expect(added.output.objects.flatMap((o) => o.part_filaments.map((p) => p.filament))).toEqual([2, 1, 3])
    expect(added.output.filaments_added).toEqual([{ filament: 2, color: '#ff0000' }, { filament: 3, color: '#0040ff' }])
  })

  it('loads every body on filament 1 with body_colors ignore', async () => {
    await call('slicerx_project_open', { name: 'plain' })
    const r = await call<Added>('slicerx_project_add_model', { model: join(h.dir, 'assembly-colors.step'), body_colors: 'ignore' })
    expect(r.output.objects.flatMap((o) => o.part_filaments.map((p) => p.filament))).toEqual([1, 1, 1])
    expect(r.output.filaments_added).toEqual([])
    expect((await call<Shown>('slicerx_project_show')).output.filaments).toHaveLength(1)
  })
})
