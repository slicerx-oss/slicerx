// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir an edition runs, read back by MCP clients: the app's answer passed on field for field, nothing else it
// might carry (never a voice text or a doc), and plain refusals without the app.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { mimirBrainTools, pick, type BrainState } from '../src/mimir-brain'

// What the app answers for an edition with a voice, printers and web off, a Sonnet step-up, synced memory and 2 docs.
const HARBOR: BrainState = {
  name: 'Pilot',
  voice: true,
  toolGroups: { design: true, slicing: true, printers: false, watch: true, paint: true, web: false },
  cloud: { base: 'claude-haiku-5-5', stepUp: 'sonnet' },
  memory: { local: true, sync: 'opt-in' },
  knowledgeDocs: 2,
}

const VOICE = 'Talk like a harbor pilot: short, calm, metric units only.'
const DOC = 'Dock 4 printers run PETG at 245 C with the door closed.'

const run = (link: AppLinkCaller | undefined) => {
  const t = mimirBrainTools(link, 'SlicerX')[0]!
  return t.run(t.input.parse({}) as never, {} as never)
}
const failing = (code: string, message = 'refused') => ({ call: (async () => { throw Object.assign(new Error(message), { code }) }) as AppLinkCaller['call'] })

describe('slicerx_mimir_brain', () => {
  it('read-back matches the edition config', async () => {
    const call = vi.fn(async () => HARBOR)
    const out = await run({ call: call as AppLinkCaller['call'] })
    expect(call).toHaveBeenCalledWith('mimir.brain', {})
    expect(out.output).toEqual(HARBOR)
    expect(out.summary).toBe('Pilot in SlicerX: the edition voice; 4 of 6 tool groups on (off: printers, web); mimir cloud on claude-haiku-5-5, asks to step up to sonnet (the proxy decides); memory on this computer, sync opt-in; 2 docs of its own knowledge.')

    const stock: BrainState = { name: 'mimir', voice: false, toolGroups: Object.fromEntries(Object.keys(HARBOR.toolGroups).map((g) => [g, true])), cloud: { base: 'claude-haiku-5-5', stepUp: null }, memory: { local: true, sync: 'off' }, knowledgeDocs: 0 }
    const plain = await run({ call: (async () => stock) as AppLinkCaller['call'] })
    expect(plain.output).toEqual(stock)
    expect(plain.summary).toBe('mimir in SlicerX: the stock voice; all 6 tool groups on; mimir cloud on claude-haiku-5-5 with no step-up; memory on this computer, sync off; 0 docs of its own knowledge.')
  })

  it('no voice text or doc text leaks', async () => {
    // an app that wrongly sent more than the shape: none of it reaches the client
    const leaky = { ...HARBOR, voiceText: VOICE, docs: [{ id: 'dock', text: DOC }], cloud: { ...HARBOR.cloud, key: 'sk-ant-abcdefghijklmnop' }, memory: { ...HARBOR.memory, facts: [DOC] } }
    const out = await run({ call: (async () => leaky) as AppLinkCaller['call'] })
    expect(out.output).toEqual(HARBOR)
    const all = JSON.stringify(out)
    for (const secret of [VOICE, DOC, 'sk-ant-', 'voiceText', '"docs"']) expect(all).not.toContain(secret)
  })

  it('an answer of the wrong shape reads as safe defaults, with only the six known tool groups', async () => {
    const none = { name: '', voice: false, toolGroups: { design: false, slicing: false, printers: false, watch: false, paint: false, web: false }, cloud: { base: '', stepUp: null }, memory: { local: false, sync: 'off' }, knowledgeDocs: 0 }
    for (const bad of [null, 'mimir', 42, [], { cloud: null, memory: 'yes', toolGroups: [] }]) expect(pick(bad), JSON.stringify(bad)).toEqual(none)
    const extra = pick({ ...HARBOR, toolGroups: { ...HARBOR.toolGroups, cad: true, __proto__: { x: true }, web: 'yes' }, knowledgeDocs: 2.5 })
    expect(Object.keys(extra.toolGroups)).toEqual(['design', 'slicing', 'printers', 'watch', 'paint', 'web'])
    expect(extra.toolGroups.web).toBe(false)
    expect(extra.knowledgeDocs).toBe(0)
    // run never fails on it either
    const out = await run({ call: (async () => null) as AppLinkCaller['call'] })
    expect(out.output).toEqual(none)
    expect(out.summary).toContain('mimir cloud on its base model with no step-up')
  })

  it('TOOLS.md is current', () => {
    const doc = readFileSync(join(__dirname, '../TOOLS.md'), 'utf8')
    expect(doc).toContain('| `slicerx_mimir_brain` |')
    expect(doc).toContain('never the voice text or the docs themselves')
  })

  it('refuses plainly without the app', async () => {
    await expect(run(undefined)).rejects.toMatchObject({ code: 'not_configured', message: /--printers link/ })
    for (const code of ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']) await expect(run(failing(code))).rejects.toMatchObject({ code: 'not_configured' })
    await expect(run(failing('bad_request', 'unknown method mimir.brain'))).rejects.toMatchObject({ code: 'not_configured' })
    await expect(run(failing('internal', 'the app broke'))).rejects.toMatchObject({ code: 'internal_error', message: 'the app broke' })
  })
})
