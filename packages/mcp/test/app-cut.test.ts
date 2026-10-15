// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it, vi } from 'vitest'
import { appCutTools } from '../src/app-cut'
import { cutInput } from '../src/cut-input'
import type { AppLinkCaller } from '../src/app-route'
import { connect } from './helpers'

const args = { object: 'body', plane: { axis: 'z', at: 8 }, connector: { kind: 'dowel', positions: [[5,5,8]] } }

it('forwards the parsed command and returns the actual app result without replacing it with the request', async () => {
  const output = { changed: true, ids: ['lower', 'upper', 'dowel'], warnings: ['One pin did not fit.'], reports: [{ part: 0, report: { connectors: [[5,5,8]] } }], objects: [{ id: 'upper', printable: false }] }
  const answer = { summary: 'Cut body into 3 objects.', output }
  const call = vi.fn(async () => answer)
  const [tool] = appCutTools({ call } as AppLinkCaller, 'Workshop')
  expect(tool!.name).toBe('project.cut')
  expect(tool!.permission).toBe('slice')
  expect(await tool!.run(tool!.input.parse(args) as never, {} as never)).toBe(answer)
  expect(call).toHaveBeenCalledWith('project.cut', { ...args, keep: 'both', connector: { ...args.connector, diameter_mm: 5, depth_mm: 6 } })
})

it.each(['read_only', 'refused', 'busy', 'not_found', 'app_closed'])('preserves the refusal meaning for %s', async (code) => {
  const call = async () => { throw Object.assign(new Error('Cannot cut.'), { code }) }
  const [tool] = appCutTools({ call } as AppLinkCaller, 'Workshop')
  const expected = code === 'app_closed' ? 'not_configured' : ['read_only', 'refused'].includes(code) ? 'not_supported' : code
  await expect(tool!.run(tool!.input.parse(args) as never, {} as never)).rejects.toMatchObject({ code: expected })
})

it('rejects unknown fields, zero normals and explicit dovetails', () => {
  expect(cutInput.safeParse({ ...args, approve: true }).success).toBe(false)
  expect(cutInput.safeParse({ ...args, plane: { point: [0,0,0], normal: [0,0,0] } }).success).toBe(false)
  expect(cutInput.safeParse({ ...args, connector: { ...args.connector, kind: 'dovetail' } }).success).toBe(false)
})

it('lists the command over MCP and refuses app-unavailable calls without a local fallback', async () => {
  const h = await connect()
  expect((await h.client.listTools()).tools.some((tool) => tool.name === 'slicerx_project_cut')).toBe(true)
  expect(await h.call('slicerx_project_cut', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_configured' } } })
})
