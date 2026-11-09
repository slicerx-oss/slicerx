// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The read permission class runs without asking; it says nothing about whether a tool changes anything. Every read
// class tool states hints.readOnly (defineTool refuses one that does not, and its type requires it), and the server
// lists readOnlyHint true only for a tool that says it changes nothing. A read class tool that changes what the app
// shows, a display preference, this server's working project or designs, a file it writes, or sends something
// declares hints.readOnly false. The sweep builds the server with an app link and a geometry engine, so the tools
// that only register with them are checked too.
import type { PilotTool } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { mcpName } from '../src/gate'
import { serverTools } from '../src/server'
import { createCardPlans, createPlanRegistry, mimirTabTools } from '../src/toolset'
import { connect, type Harness } from './helpers'
import { AGENT_CODE, scriptedLinkHub } from './helpers/scripted-hub'

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
  'app.sheet_ask',
  'mimir.ask',
  'mimir.dismiss',
  'design.open',
  'design.put_plan',
  'paint.preview',
  'project.open',
  'project.add_model',
  'sxlock.open',
]

/** Words in a tool name that say it changes something. */
const CHANGE_WORDS = new Set([
  'set', 'open', 'add', 'remove', 'delete', 'create', 'rename', 'update', 'apply', 'clear', 'write', 'save', 'jump', 'show',
  'select', 'push', 'import', 'export', 'install', 'start', 'stop', 'cancel', 'pause', 'resume', 'send', 'upload', 'queue',
  'move', 'edit', 'copy', 'bind', 'keep', 'undo', 'redo', 'approve', 'ask', 'dismiss', 'put', 'plan',
])

/** Read class tools whose names carry one of those words but which only read, checked by hand. */
const READS_DESPITE_NAME = [
  'project.show', 'app.select_under', 'app.model_push', 'app.model_op_preview', 'resume_from_layer', 'settings.plan',
  'plan_settings', 'geom.layers_plan', 'geom.resume_plan', 'geom.sketch_edit',
]

/** The server with every tool it can register: an app link (a scripted hub) and a geometry engine that is never called. */
async function everything(): Promise<Harness> {
  const hub = scriptedLinkHub((method) => (method === 'list' ? [] : {}))
  return connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: AGENT_CODE, linkWebSocket: hub.WS, geomEngine: async () => ({}) })
}

/** Every tool across the server configurations, plus the mimir tab's own tools (design.plan and the cards). */
async function sweep(): Promise<{ tools: Map<string, PilotTool<never>>; listed: Map<string, { readOnlyHint?: boolean | undefined }> }> {
  const tools = new Map<string, PilotTool<never>>()
  const listed = new Map<string, { readOnlyHint?: boolean | undefined }>()
  for (const make of [() => connect(), everything]) {
    const h = await make()
    try {
      for (const t of serverTools(h.ctx)) if (!tools.has(t.name)) tools.set(t.name, t)
      for (const t of (await h.client.listTools()).tools) listed.set(t.name, t.annotations ?? {})
    } finally {
      await h.client.close()
    }
  }
  for (const t of mimirTabTools(createCardPlans(createPlanRegistry()).planTool())) if (!tools.has(t.name)) tools.set(t.name, t)
  return { tools, listed }
}

describe('read class tools and readOnlyHint', () => {
  it('sweeps the link-only and engine-only tools too', async () => {
    const { tools } = await sweep()
    for (const name of ['mimir.ask', 'mimir.dismiss', 'app.sheet_ask', 'design.open', 'design.put_plan', 'design.plan', 'geom.faces', 'app.undo']) expect(tools.has(name), name).toBe(true)
  })

  it('every read class tool states hints.readOnly, and the listing follows it', async () => {
    const { tools, listed } = await sweep()
    for (const t of tools.values()) {
      if (t.permission !== 'read') continue
      expect(typeof t.hints?.readOnly, `${t.name} states hints.readOnly`).toBe('boolean')
      const shown = listed.get(mcpName(t.name))
      if (shown && !t.permissionFor) expect(shown.readOnlyHint === true, `${mcpName(t.name)} readOnlyHint`).toBe(t.hints?.readOnly === true)
    }
  })

  it('lists the tools that change something with readOnlyHint false', async () => {
    const { tools, listed } = await sweep()
    for (const name of [...READ_CLASS_CHANGES, 'design.plan']) {
      const tool = tools.get(name)
      expect(tool, `${name} is registered`).toBeDefined()
      expect(tool?.permission, name).toBe('read')
      expect(tool?.hints?.readOnly, `${name} declares hints.readOnly false`).toBe(false)
      if (name !== 'design.plan') expect(listed.get(mcpName(name))?.readOnlyHint, `${mcpName(name)} readOnlyHint`).toBe(false)
    }
    expect(tools.get('mimir.ask')?.hints?.openWorld, 'mimir.ask sends a message and files').toBe(true)
  })

  it('has no read-only read class tool named like a change that was not checked by hand', async () => {
    const { tools } = await sweep()
    const unmarked = [...tools.values()]
      .filter((t) => t.permission === 'read' && !t.permissionFor && t.hints?.readOnly !== false && !READS_DESPITE_NAME.includes(t.name))
      .filter((t) => (t.name.split('.').at(-1) ?? '').split('_').some((w) => CHANGE_WORDS.has(w)))
      .map((t) => t.name)
    // A new read tool named like a change either declares hints.readOnly false or joins READS_DESPITE_NAME after a check.
    expect(unmarked).toEqual([])
    for (const name of READS_DESPITE_NAME) expect(tools.get(name)?.permission, `${name} is still a read tool`).toBe('read')
  })

  it('leaves plain reads listed as read-only', async () => {
    const { listed } = await sweep()
    for (const name of ['app.look', 'app.units', 'app.preview', 'project.show', 'app.select_under', 'sxlock.inspect', 'mimir.session', 'design.steps', 'geom.faces']) {
      expect(listed.get(mcpName(name))?.readOnlyHint, mcpName(name)).toBe(true)
    }
  })
})
