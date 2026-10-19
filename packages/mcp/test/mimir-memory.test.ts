// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's memory for MCP clients: facts read back as the app answers them (secrets already hidden there), a fact added
// through the link, and plain refusals for a read-only client, a secret, or no app.
import { describe, expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { mimirMemoryTools } from '../src/mimir-memory'

const FACTS = [
  { id: 'f2', kind: 'filament', text: 'Prints PLA at 215 C on the textured plate', updatedAt: 30 },
  { id: 'f1', kind: 'printer', text: 'A Bambu Lab P1S with a 0.4 mm nozzle, access code [hidden]', data: { nozzleMm: 0.4, accessCode: '[hidden]' }, updatedAt: 10 },
]
const tools = (link: AppLinkCaller | undefined) => mimirMemoryTools(link, 'SlicerX')
const read = (link: AppLinkCaller | undefined, input: object = {}) => tools(link)[0]!.run(tools(link)[0]!.input.parse(input) as never, {} as never)
const remember = (link: AppLinkCaller | undefined, input: object) => tools(link)[1]!.run(tools(link)[1]!.input.parse(input) as never, {} as never)
const failing = (code: string, message = 'refused') => ({ call: (async () => { throw Object.assign(new Error(message), { code }) }) as AppLinkCaller['call'] })

describe('mimir memory for MCP clients', () => {
  it('read lists facts without secrets', async () => {
    const call = vi.fn(async () => ({ facts: FACTS, hidden: 1 }))
    const out = await read({ call: call as AppLinkCaller['call'] })
    expect(call).toHaveBeenCalledWith('mimir.memory', {})
    expect(out.output).toEqual({ facts: FACTS, hidden: 1 })
    expect(out.summary).toBe('mimir remembers 2 facts in SlicerX; a secret was hidden in 1 fact.')
    expect(JSON.stringify(out)).not.toMatch(/\d{8}/)
    await read({ call: call as AppLinkCaller['call'] }, { kind: 'filament' })
    expect(call).toHaveBeenLastCalledWith('mimir.memory', { kind: 'filament' })
    expect(() => tools(undefined)[0]!.input.parse({ kind: 'secrets' })).toThrow()
  })

  it('says when there is nothing to read yet', async () => {
    const out = await read({ call: (async () => ({ facts: [], hidden: 0 })) as AppLinkCaller['call'] }, { kind: 'size' })
    expect(out.summary).toBe('mimir remembers no size facts in SlicerX yet.')
  })

  it('remember adds a fact through the link and reads it back', async () => {
    const fact = { id: 'n1', kind: 'outcome', text: 'PETG at 0.2 mm layers worked for the hinge', data: { layerMm: 0.2 }, updatedAt: 99 }
    const call = vi.fn(async () => ({ fact }))
    const out = await remember({ call: call as AppLinkCaller['call'] }, { kind: 'outcome', text: ' PETG at 0.2 mm layers worked for the hinge ', data: { layerMm: 0.2 } })
    expect(call).toHaveBeenCalledWith('mimir.memory_remember', { kind: 'outcome', text: 'PETG at 0.2 mm layers worked for the hinge', data: { layerMm: 0.2 } })
    expect(out.output).toEqual({ fact })
    expect(out.summary).toBe('mimir will remember this outcome fact in SlicerX: PETG at 0.2 mm layers worked for the hinge')
  })

  it('remember is refused for a read-only client', async () => {
    const readOnly = failing('read_only', 'the person allowed my-script to read the open project, not to change it')
    await expect(remember(readOnly, { kind: 'printer', text: 'A P1S' })).rejects.toMatchObject({ code: 'not_supported', message: /read the open project, not to change it/, details: { appLink: 'read_only' } })
    await expect(remember(failing('denied'), { kind: 'printer', text: 'A P1S' })).rejects.toMatchObject({ code: 'not_supported' })
  })

  it('passes on the refusal of a secret, and a missing memory store', async () => {
    const secret = failing('refused', 'mimir does not keep secrets: this looks like a key, an access code or a serial number. Leave it out and try again.')
    await expect(remember(secret, { kind: 'printer', text: 'access code 12345678' })).rejects.toMatchObject({ code: 'invalid_input', message: /does not keep secrets/ })
    const none = failing('not_ready', 'memory unavailable: mimir keeps no memory in this SlicerX window, or it is turned off')
    await expect(read(none)).rejects.toMatchObject({ code: 'not_configured', message: /^memory unavailable/ })
  })

  it('refuses plainly without the app', async () => {
    await expect(read(undefined)).rejects.toMatchObject({ code: 'not_configured', message: /--printers link/ })
    await expect(remember(undefined, { kind: 'size', text: 'Hands are 9 cm across' })).rejects.toMatchObject({ code: 'not_configured' })
    for (const code of ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']) await expect(read(failing(code))).rejects.toMatchObject({ code: 'not_configured' })
  })
})
