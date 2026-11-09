// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Taking objects off a plate is the remove class, which asks first by default, whatever slice is set to. The sweep
// builds the server with an app link and a geometry engine and checks every tool that can take objects off: removing
// an object, deleting a plate with its objects, Undo and Redo (the app cannot say beforehand what a step undoes), and
// opening a new working project over one that has objects. Tools whose names sound like removal but keep every
// object were checked by hand and are listed.
import type { PilotTool } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { serverTools } from '../src/server'
import { connect, data } from './helpers'
import { AGENT_CODE, scriptedLinkHub } from './helpers/scripted-hub'

/** Tools that take objects off a plate, with the input that does it. */
const REMOVES: [string, Record<string, unknown>][] = [
  ['project.remove_object', { object: 'obj-1' }],
  ['app.plate_remove', { plate: 2, deleteObjects: true }],
  ['app.undo', { revision: 'r' }],
  ['app.redo', { revision: 'r' }],
]

/**
 * Tools named like removal that keep every object, checked by hand: a volume, a value, a mark, paint, a dimension, a
 * plate whose objects move, a preset setting, a cut that splits a part, and a design redo, which puts a step back.
 */
const KEEPS_OBJECTS = new Set(['geom.cut', 'design.redo', 'app.preset_undo', 'project.remove_volume', 'app.volume_remove', 'app.value_remove', 'app.paint_clear', 'app.dimension_remove', 'project_layer_mark_remove', 'project.plate_remove', 'remove_from_fleet', 'delete_fleet'])

async function tools(): Promise<Map<string, PilotTool<never>>> {
  const hub = scriptedLinkHub((method) => (method === 'list' ? [] : {}))
  const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: AGENT_CODE, linkWebSocket: hub.WS, geomEngine: async () => ({}) })
  try {
    return new Map(serverTools(h.ctx).map((t) => [t.name, t]))
  } finally {
    await h.client.close()
  }
}

const classOf = (t: PilotTool<never>, input: Record<string, unknown>) => t.permissionFor?.(t.input.parse(input) as never) ?? t.permission

describe('the remove class', () => {
  it('covers every tool that takes objects off a plate', async () => {
    const all = await tools()
    for (const [name, input] of REMOVES) {
      const tool = all.get(name)
      expect(tool, name).toBeDefined()
      expect(classOf(tool!, input), name).toBe('remove')
    }
    // A design this server cannot find never skips the question.
    expect(classOf(all.get('design.undo')!, { design: 'nowhere' })).toBe('remove')
    // An empty plate's removal moves nothing off, so it stays slice.
    expect(classOf(all.get('app.plate_remove')!, { plate: 2 })).toBe('slice')
  })

  it('leaves no tool named like a removal outside it unless it was checked', async () => {
    const all = await tools()
    const loose = [...all.values()]
      .filter((t) => /(^|[._])(remove|delete|clear|cut|undo|redo|discard|reset)(_|$)/.test(t.name) && !KEEPS_OBJECTS.has(t.name))
      .filter((t) => t.permission !== 'remove' && !t.permissionFor)
      .map((t) => t.name)
    expect(loose).toEqual([])
  })

  it('asks before project.open replaces a working project that has objects, and not before a first one', async () => {
    const h = await connect()
    try {
      const first = data<{ status?: string }>(await h.call('slicerx_project_open', { name: 'first' }))
      expect(first.status).toBeUndefined()
      expect((await h.call('slicerx_project_add_model', { model: 'sample:cube-20' })).isError).toBeFalsy()
      const asked = data<{ status: string; permission: string; title: string; request_id: string }>(await h.call('slicerx_project_open', { name: 'second' }))
      expect(asked).toMatchObject({ status: 'approval_required', permission: 'remove', title: 'Replace the open project "first" and its 1 object?' })
      expect(data<{ output: { name: string } }>(await h.call('slicerx_project_show')).output.name).toBe('first')
      expect((await h.call('slicerx_approve', { request_id: asked.request_id, approve: true })).isError).toBeFalsy()
      expect(data<{ output: { name: string } }>(await h.call('slicerx_project_show')).output.name).toBe('second')
    } finally {
      await h.client.close()
    }
  })

  it('runs Undo without a card when the policy allows remove, and refuses it when remove is off', async () => {
    for (const [mode, refused] of [['allow', false], ['off', true]] as const) {
      const hub = scriptedLinkHub((method) => (method === 'list' ? [] : method === 'app.call' ? { revision: 'r2', undo: 0, redo: 1, changed: true } : {}))
      const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: AGENT_CODE, linkWebSocket: hub.WS, policy: { classes: { slice: 'allow', remove: mode, queue: 'ask', start: 'ask', profile: 'ask' } } })
      try {
        const r = await h.call('slicerx_app_undo', { revision: 'r' })
        if (refused) expect(data<{ status: string }>(r).status).toBe('off')
        else expect(data<{ status?: string }>(r).status).not.toBe('approval_required')
        expect(hub.sent.some((s) => JSON.stringify(s).includes('history.undo'))).toBe(!refused)
      } finally {
        await h.client.close()
      }
    }
  })
})
