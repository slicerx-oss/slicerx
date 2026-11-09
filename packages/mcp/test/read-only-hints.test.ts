// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The read permission class runs without asking, and the server lists a read tool as read-only (readOnlyHint) unless
// the tool says otherwise. A read class tool that changes anything (what the app shows, a display preference, this
// server's working project, a file it writes, a network call that does something) declares hints.readOnly false, so a
// client never takes it for a call that changes nothing.
import { describe, expect, it } from 'vitest'
import { mcpName } from '../src/gate'
import { serverTools } from '../src/server'
import { connect } from './helpers'

/** Read class tools that change something, checked by hand against what each one's run does. */
const READ_CLASS_CHANGES = [
  'app.ui_set',
  'app.plate_show',
  'app.look_set',
  'app.units_set',
  'app.pick_filter_set',
  'app.preview_set',
  'app.preview_markers_set',
  'app.preview_playback_set',
  'app.preview_gcode_jump',
  'app.select_other',
  'app.model_push_set',
  'app.dimensions_show',
  'app.paint_preview',
  'app.paint_from_texture',
  'project.open',
  'project.add_model',
  'sxlock.open',
]

/** Words in a tool name that say it changes something. */
const CHANGE_WORDS = new Set([
  'set', 'open', 'add', 'remove', 'delete', 'create', 'rename', 'update', 'apply', 'clear', 'write', 'save', 'jump', 'show',
  'select', 'push', 'import', 'export', 'install', 'start', 'stop', 'cancel', 'pause', 'resume', 'send', 'upload', 'queue',
  'move', 'edit', 'copy', 'bind', 'keep', 'undo', 'redo', 'approve',
])

/** Read class tools whose names carry one of those words but which only read, checked by hand. */
const READS_DESPITE_NAME = ['project.show', 'app.select_under', 'app.model_push', 'resume_from_layer']

describe('read class tools that change something', () => {
  it('are listed with readOnlyHint false', async () => {
    const h = await connect()
    try {
      const tools = serverTools(h.ctx)
      const listed = new Map((await h.client.listTools()).tools.map((t) => [t.name, t]))
      for (const name of READ_CLASS_CHANGES) {
        const tool = tools.find((t) => t.name === name)
        expect(tool, `${name} is registered`).toBeDefined()
        expect(tool?.permission, name).toBe('read')
        expect(tool?.hints?.readOnly, `${name} declares hints.readOnly false`).toBe(false)
        expect(listed.get(mcpName(name))?.annotations?.readOnlyHint, `${mcpName(name)} readOnlyHint`).toBe(false)
      }
    } finally {
      await h.client.close()
    }
  })

  it('include every read class tool whose name says it changes something', async () => {
    const h = await connect()
    try {
      const unmarked = serverTools(h.ctx)
        .filter((t) => t.permission === 'read' && !t.permissionFor && t.hints?.readOnly !== false && !READS_DESPITE_NAME.includes(t.name))
        .filter((t) => (t.name.split('.').at(-1) ?? '').split('_').some((w) => CHANGE_WORDS.has(w)))
        .map((t) => t.name)
      // A new read tool named like a change either declares hints.readOnly false or joins READS_DESPITE_NAME after a check.
      expect(unmarked).toEqual([])
      const reads = new Set(serverTools(h.ctx).filter((t) => t.permission === 'read').map((t) => t.name))
      for (const name of READS_DESPITE_NAME) expect(reads.has(name), `${name} is still a read tool`).toBe(true)
    } finally {
      await h.client.close()
    }
  })

  it('leave plain reads listed as read-only', async () => {
    const h = await connect()
    try {
      const listed = new Map((await h.client.listTools()).tools.map((t) => [t.name, t]))
      for (const name of ['app.look', 'app.units', 'app.preview', 'project.show', 'app.select_under', 'sxlock.inspect']) {
        expect(listed.get(mcpName(name))?.annotations?.readOnlyHint, mcpName(name)).toBe(true)
      }
    } finally {
      await h.client.close()
    }
  })
})
